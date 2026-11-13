import unittest
from check_plan import violations


def plan(address, actions):
    return {"resource_changes": [{"address": address, "mode": "managed", "change": {"actions": actions}}]}


class PlanTests(unittest.TestCase):
    def test_existing_server_noop(self):
        self.assertEqual(violations(plan("aws_instance.k3s", ["no-op"]), "default"), [])

    def test_server_replacement_rejected_in_both_modes(self):
        for mode in ("default", "agents"):
            self.assertTrue(violations(plan("aws_instance.k3s", ["delete", "create"]), mode))

    def test_existing_network_and_bucket_update_rejected(self):
        for address in ("aws_vpc.main", "aws_vpc_endpoint.s3", "aws_s3_bucket.data"):
            self.assertTrue(violations(plan(address, ["update"]), "agents"))

    def test_only_known_additions_pass_agent_gate(self):
        self.assertEqual(violations(plan('aws_instance.agent["app-a"]', ["create"]), "agents"), [])
        self.assertTrue(violations(plan("aws_instance.unreviewed", ["create"]), "agents"))

    def test_default_rejects_new_agents(self):
        self.assertTrue(violations(plan('aws_instance.agent["app-a"]', ["create"]), "default"))

    def test_legacy_rejects_agent_create_delete_and_noop(self):
        for actions in (["create"], ["no-op"], ["delete"]):
            self.assertTrue(violations(plan('aws_instance.agent["data-a"]', actions), "legacy"))

    def test_existing_agents_cannot_be_removed_or_replaced(self):
        for actions in (["delete"], ["delete", "create"]):
            self.assertTrue(violations(plan('aws_instance.agent["data-a"]', actions), "agents"))

    def test_empty_or_incomplete_plan_rejected(self):
        self.assertTrue(violations({}, "default"))
        self.assertTrue(violations({"complete": False, "resource_changes": []}, "agents"))


if __name__ == "__main__":
    unittest.main()
