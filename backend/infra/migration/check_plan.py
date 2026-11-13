#!/usr/bin/env python3
"""Check terraform show -json using a deliberately narrow preservation allowlist.

default: existing managed resources must be no-op.
agents: permit only agent additions and node SG rules; existing resources stay no-op.
legacy: reject the private-agent layout in infra.sh's old automatic up path.
"""
import argparse
import json
import sys

ADDITIONS = {
    "aws_subnet.private", "aws_eip.nat", "aws_nat_gateway.agents",
    "aws_route_table.private", "aws_route_table_association.private",
    "aws_security_group.agent", "aws_vpc_security_group_ingress_rule.node_mesh",
    "aws_vpc_security_group_ingress_rule.agent_api", "aws_vpc_security_group_egress_rule.agent",
    "aws_iam_role.agent", "aws_iam_role_policy_attachment.agent_ssm", "aws_iam_role_policy.agent",
    "aws_iam_instance_profile.agent", "aws_instance.agent",
    "aws_vpc_endpoint.agents_s3",
}


def violations(plan, mode):
    errors = []
    if plan.get("errored") or plan.get("complete") is False:
        errors.append("계획이 완성되지 않았습니다")
    if not isinstance(plan.get("resource_changes"), list):
        return errors + ["resource_changes가 없습니다"]
    for resource in plan["resource_changes"]:
        if resource.get("mode") != "managed":
            continue
        address = resource["address"]
        base = address.split("[")[0]
        change = resource["change"]
        actions = change["actions"]
        if mode == "legacy":
            if base in ADDITIONS and actions != ["delete"]:
                errors.append(f"{address}: 사설 agent 구성은 legacy up으로 적용할 수 없습니다")
            # An old down/up must not delete existing agent resources either.
            if base in ADDITIONS and actions == ["delete"]:
                errors.append(f"{address}: 기존 agent를 지우는 계획입니다")
            continue
        if actions == ["no-op"]:
            continue
        if mode == "agents" and actions == ["create"] and base in ADDITIONS:
            continue
        errors.append(f"{address}: 허용되지 않은 동작 {actions}")
    return errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("default", "agents", "legacy"))
    args = parser.parse_args()
    errors = violations(json.load(sys.stdin), args.mode)
    print("\n".join(errors) if errors else f"{args.mode}: 보존 조건 통과")
    sys.exit(bool(errors))
