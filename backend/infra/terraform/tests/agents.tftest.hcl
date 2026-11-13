# No AWS/Cloudflare credentials or infrastructure writes. Plan semantics, not a live join test.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "721622471953" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-northeast-2a", "ap-northeast-2b"] }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
  mock_data "aws_lbs" {
    defaults = { arns = [] }
  }
}
mock_provider "cloudflare" {}

run "default_preserves_single_server" {
  command = plan
  assert {
    condition     = length(aws_instance.agent) == 0 && length(aws_nat_gateway.agents) == 0 && length(aws_subnet.private) == 0 && length(aws_iam_role.agent) == 0
    error_message = "The default must not provision private agents or NAT/IAM."
  }
  assert {
    condition     = aws_instance.k3s.instance_type == "t4g.large" && aws_instance.k3s.associate_public_ip_address && aws_instance.k3s.root_block_device[0].volume_size == 40
    error_message = "The existing server must retain its shape and placement."
  }
}

run "private_agents_by_role" {
  command = plan
  variables {
    enable_private_agents = true
  }
  assert {
    condition     = toset(keys(aws_instance.agent)) == toset(["app-a", "app-b", "data-a"]) && length(aws_nat_gateway.agents) == 2
    error_message = "The target is three agents and one NAT per AZ."
  }
  assert {
    condition     = local.agents["app-a"].az != local.agents["app-b"].az && local.agents["data-a"].az == local.agents["app-a"].az
    error_message = "App agents must span two AZs; data stays in AZ a."
  }
  assert {
    condition     = alltrue([for node in aws_instance.agent : !node.associate_public_ip_address && node.metadata_options[0].http_tokens == "required" && node.metadata_options[0].http_put_response_hop_limit == 1 && node.root_block_device[0].encrypted])
    error_message = "Agents must stay private with encrypted disks and host-only IMDSv2."
  }
  assert {
    condition     = toset([for s in aws_subnet.private : s.cidr_block]) == toset(["10.10.10.0/24", "10.10.11.0/24"])
    error_message = "Private subnets must not overlap the existing public, pod or service ranges."
  }
  assert {
    condition     = alltrue([for rule in aws_vpc_security_group_ingress_rule.node_mesh : rule.cidr_ipv4 == null])
    error_message = "Inter-node ports must use source security groups, never public CIDRs."
  }
  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.agent.statement :
      s.effect == "Deny" && s.not_resources == toset(local.agent_bootstrap_parameters) && contains(s.actions, "ssm:GetParameters")
      if s.sid == "DenyOtherParameters"
    ]) && length([for s in data.aws_iam_policy_document.agent.statement : s if s.sid == "DenyOtherParameters"]) == 1
    error_message = "SSM Core's wildcard parameter reads must be explicitly denied outside the two bootstrap paths."
  }
}
