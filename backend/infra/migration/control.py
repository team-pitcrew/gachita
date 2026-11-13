#!/usr/bin/env python3
"""P01: preserve sync policies before freezing; retain the fence after resuming.

Run on the existing server through infra.sh migration. No Secret/DB reads or writes.
All operators must serialize migration and deployment jobs during maintenance.
"""
import argparse
import copy
import fcntl
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

NAME = "gachita-cluster-migration"
APPS = ("root", "cluster-base", "gateway-api", "cert-manager", "cnpg",
        "external-secrets", "barman-cloud", "pod-identity-webhook", "secret-stores",
        "db", "aws-load-balancer-controller", "api", "edge")


class Kubernetes:
    def call(self, *args, obj=None):
        result = subprocess.run(
            ["kubectl", "--request-timeout=20s", *args],
            input=json.dumps(obj) if obj is not None else None,
            text=True, capture_output=True, check=True,
        )
        return json.loads(result.stdout) if result.stdout.strip() else None

    def state(self):
        return self.call("-n", "kube-system", "get", "configmap", NAME,
                         "--ignore-not-found", "-o", "json")

    def save(self, state, previous):
        obj = copy.deepcopy(previous) if previous else {
            "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": {"name": NAME, "namespace": "kube-system"},
        }
        obj["data"] = {"state.json": json.dumps(state, sort_keys=True)}
        return self.call("create" if previous is None else "replace", "-f", "-", "-o", "json", obj=obj)

    def app(self, name):
        return self.call("-n", "argocd", "get", "application", name, "-o", "json")

    def auto(self, app, value):
        # CAS prevents overwriting a concurrent application change or a newly queued sync.
        policy = copy.deepcopy(app["spec"].get("syncPolicy", {}))
        if value["present"]:
            policy["automated"] = value["value"]
        else:
            policy.pop("automated", None)
        patch = [
            {"op": "test", "path": "/metadata/resourceVersion", "value": app["metadata"]["resourceVersion"]},
            {"op": "add", "path": "/spec/syncPolicy", "value": policy},
        ]
        self.call("-n", "argocd", "patch", "application", app["metadata"]["name"],
                  "--type=json", "-p", json.dumps(patch), "-o", "json")


def idle(app):
    if app.get("operation") or app.get("status", {}).get("operationState", {}).get("phase") in ("Running", "Terminating"):
        raise RuntimeError(f"{app['metadata']['name']}: 진행 중인 sync가 있습니다. 완료 후 다시 실행하십시오")


def snapshot(app):
    policy = app["spec"].get("syncPolicy", {})
    return {"uid": app["metadata"]["uid"], "present": "automated" in policy,
            "value": copy.deepcopy(policy.get("automated"))}


class Control:
    def __init__(self, api):
        self.api = api

    def run(self, action):
        record = self.api.state()  # Errors must not be treated as "not in migration".
        if action == "guard":
            if record is not None:
                raise RuntimeError("전환 기록이 있습니다. 단일 노드 up/down/converge/backup/restore/clean-e2e를 사용할 수 없습니다")
            return {"phase": "legacy"}
        state = json.loads(record["data"]["state.json"]) if record else None
        if action == "status":
            return state or {"phase": "legacy"}
        if state and (state.get("version") != 1 or state.get("active_database") != "gachita-db/db"):
            raise RuntimeError("이 도구가 지원하지 않는 전환 상태 또는 활성 DB입니다")
        if action == "freeze":
            if state is None or state["phase"] == "resumed":
                apps = [self.api.app(name) for name in APPS]
                for app in apps:
                    idle(app)
                state = {
                    "version": 1, "phase": "freezing", "active_database": "gachita-db/db",
                    "started_at": datetime.now(timezone.utc).isoformat(),
                    "node_roles": {"existing-server": "platform", "app-a": "app", "app-b": "app", "data-a": "data"},
                    "policies": {app["metadata"]["name"]: snapshot(app) for app in apps},
                }
                record = self.api.save(state, record)  # Durable fence before the first patch.
            if state["phase"] not in ("freezing", "frozen"):
                raise RuntimeError("재개가 진행 중입니다. resume으로 마무리하십시오")
            order = APPS  # Parent first; prevents root self-heal undoing child patches.
        else:
            if state is None or state["phase"] == "resumed":
                return state or {"phase": "legacy"}
            if state["phase"] not in ("freezing", "frozen", "resuming"):
                raise RuntimeError("알 수 없는 전환 단계입니다")
            state["phase"] = "resuming"
            record = self.api.save(state, record)
            order = (*APPS[1:], "root")  # Children first, parent last.
        for name in order:
            app = self.api.app(name)
            saved = state["policies"][name]
            if app["metadata"]["uid"] != saved["uid"]:
                raise RuntimeError(f"{name}: 앱이 재생성되었습니다. 원래 정책을 자동으로 덮어쓰지 않습니다")
            idle(app)
            desired = saved if action == "resume" else {"present": True, "value": {"enabled": False}}
            if snapshot(app)["present"] != desired["present"] or snapshot(app)["value"] != desired.get("value"):
                self.api.auto(app, desired)
            if action == "freeze":
                idle(self.api.app(name))
        if action == "freeze":
            # Detect concurrent re-enablement/manual sync before declaring the freeze complete.
            for name in APPS:
                app = self.api.app(name)
                idle(app)
                if (app["spec"].get("syncPolicy", {}).get("automated") or {}).get("enabled") is not False:
                    raise RuntimeError(f"{name}: 동결 상태가 바뀌었습니다. 수동 운영을 중지하고 재시도하십시오")
        state["phase"] = "frozen" if action == "freeze" else "resumed"
        self.api.save(state, record)
        return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "guard", "freeze", "resume"))
    args = parser.parse_args()
    os.environ.setdefault("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")
    # All SSM invocations land on the same existing server. Never wait behind another mutation.
    with open("/run/gachita-migration.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(Control(Kubernetes()).run(args.action), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"전환 작업 중단: {error}", file=sys.stderr)
        sys.exit(1)
