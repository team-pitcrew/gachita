import copy
import unittest

from control import APPS, Control


class Cluster:
    def __init__(self):
        self.record = None
        self.events = []
        self.fail_app = None
        self.apps = {name: {
            "metadata": {"name": name, "uid": name + "-uid"},
            "spec": {"syncPolicy": {"automated": {"prune": True, "selfHeal": True}, "retry": {"limit": 5}}},
        } for name in APPS}

    def state(self):
        return copy.deepcopy(self.record)

    def save(self, state, previous):
        import json
        if previous != self.record:
            raise RuntimeError("state conflict")
        self.events.append(("save", state["phase"]))
        self.record = {"data": {"state.json": json.dumps(state)}}
        return self.state()

    def app(self, name):
        return copy.deepcopy(self.apps[name])

    def auto(self, app, value):
        name = app["metadata"]["name"]
        if name == self.fail_app:
            raise RuntimeError("API unavailable")
        self.events.append(("auto", name))
        if value["present"]:
            self.apps[name]["spec"]["syncPolicy"]["automated"] = copy.deepcopy(value["value"])
        else:
            self.apps[name]["spec"]["syncPolicy"].pop("automated", None)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.cluster = Cluster()
        self.control = Control(self.cluster)

    def test_freeze_saves_before_parent_then_children(self):
        self.assertEqual(self.control.run("freeze")["phase"], "frozen")
        self.assertEqual(self.cluster.events[:2], [("save", "freezing"), ("auto", "root")])
        for app in self.cluster.apps.values():
            self.assertFalse(app["spec"]["syncPolicy"]["automated"]["enabled"])
            self.assertEqual(app["spec"]["syncPolicy"]["retry"], {"limit": 5})

    def test_repeat_freeze_preserves_original_snapshot(self):
        first = self.control.run("freeze")
        events = len(self.cluster.events)
        self.assertEqual(self.control.run("freeze")["policies"], first["policies"])
        self.assertEqual(self.cluster.events[events:], [("save", "frozen")])

    def test_resume_restores_exact_values_and_parent_last(self):
        self.cluster.apps["api"]["spec"]["syncPolicy"].pop("automated")
        self.cluster.apps["edge"]["spec"]["syncPolicy"]["automated"] = None
        self.cluster.apps["db"]["spec"]["syncPolicy"]["automated"] = {"enabled": False, "prune": False}
        before = copy.deepcopy(self.cluster.apps)
        self.control.run("freeze")
        self.assertEqual(self.control.run("resume")["phase"], "resumed")
        self.assertEqual(self.cluster.apps, before)
        self.assertEqual(self.cluster.events[-2:], [("auto", "root"), ("save", "resumed")])

    def test_partial_failure_retains_fence_and_original_policies(self):
        self.cluster.fail_app = "db"
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            self.control.run("freeze")
        with self.assertRaisesRegex(RuntimeError, "전환 기록"):
            self.control.run("guard")
        self.assertEqual(self.control.run("status")["phase"], "freezing")
        self.cluster.fail_app = None
        self.control.run("resume")
        self.assertTrue(self.cluster.apps["root"]["spec"]["syncPolicy"]["automated"]["selfHeal"])

    def test_freeze_can_retry_partial_failure(self):
        self.cluster.fail_app = "api"
        with self.assertRaises(RuntimeError):
            self.control.run("freeze")
        self.cluster.fail_app = None
        self.assertEqual(self.control.run("freeze")["phase"], "frozen")

    def test_inflight_sync_rejected_before_mutation(self):
        for state in ({"operation": {"sync": {}}}, {"status": {"operationState": {"phase": "Running"}}}):
            self.cluster.apps["api"].update(state)
            with self.assertRaisesRegex(RuntimeError, "진행 중"):
                self.control.run("freeze")
            self.assertEqual(self.cluster.events, [])

    def test_inflight_sync_after_snapshot_keeps_fence(self):
        original_save = self.cluster.save

        def racing_save(state, previous):
            result = original_save(state, previous)
            self.cluster.apps["root"]["operation"] = {"sync": {}}
            return result

        self.cluster.save = racing_save
        with self.assertRaisesRegex(RuntimeError, "진행 중"):
            self.control.run("freeze")
        self.assertEqual(self.cluster.events, [("save", "freezing")])

    def test_recreated_application_is_not_overwritten(self):
        self.control.run("freeze")
        self.cluster.apps["db"]["metadata"]["uid"] = "replacement"
        with self.assertRaisesRegex(RuntimeError, "재생성"):
            self.control.run("resume")
        self.assertFalse(self.cluster.apps["root"]["spec"]["syncPolicy"]["automated"]["enabled"])

    def test_resume_keeps_legacy_operations_blocked(self):
        self.control.run("freeze")
        self.control.run("resume")
        with self.assertRaises(RuntimeError):
            self.control.run("guard")

    def test_read_failure_is_not_absence(self):
        def unavailable():
            raise RuntimeError("API unavailable")
        self.cluster.state = unavailable
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            self.control.run("guard")

    def test_legacy_status_and_resume_do_not_write(self):
        for action in ("status", "guard", "resume"):
            self.assertEqual(self.control.run(action), {"phase": "legacy"})
        self.assertEqual(self.cluster.events, [])

    def test_refreeze_after_resume_uses_current_policies(self):
        self.control.run("freeze")
        self.control.run("resume")
        self.cluster.apps["api"]["spec"]["syncPolicy"]["automated"] = {"prune": False}
        self.control.run("freeze")
        self.control.run("resume")
        self.assertEqual(self.cluster.apps["api"]["spec"]["syncPolicy"]["automated"], {"prune": False})


if __name__ == "__main__":
    unittest.main()
