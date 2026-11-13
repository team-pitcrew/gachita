import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class LegacyGuardTests(unittest.TestCase):
    def test_mutating_commands_fail_closed_before_their_body(self):
        script = Path(__file__).resolve().parents[1] / "infra.sh"
        with tempfile.TemporaryDirectory() as tmp:
            stub = Path(tmp) / "aws"
            stub.write_text(f"#!{sys.executable}\n" + '''
import os,sys
args=' '.join(sys.argv[1:])
scenario=os.environ['GUARD_SCENARIO']
if 'ec2 describe-instances' in args:
    if scenario == 'lookup_failure': sys.exit(1)
    if 'NodePool' in args:
        print('i-abc001' if scenario == 'agents_present' else '')
    else: print('i-abc002')
elif 'ssm describe-instance-information' in args:
    print('Offline' if scenario == 'ssm_offline' else 'Online')
elif 'ssm send-command' in args:
    print('test-command')
elif 'ssm get-command-invocation' in args:
    print('Failed' if '--query Status' in args else 'migration fence or API unavailable')
else:
    raise AssertionError('Unexpected AWS action: ' + args)
''')
            stub.chmod(0o755)
            sleep = Path(tmp) / "sleep"
            sleep.write_text("#!/bin/sh\nexit 0\n")
            sleep.chmod(0o755)
            for scenario, reason in (
                ("agents_present", "사설 agent가 있습니다"),
                ("lookup_failure", "agent 조회 실패"),
                ("ssm_offline", "전환 상태를 읽을 수 없습니다"),
                ("cluster_unavailable", "전환 상태 보호 장치"),
            ):
                for command in ("up", "down", "converge", "backup", "restore", "clean-e2e"):
                    with self.subTest(scenario=scenario, command=command):
                        result = subprocess.run(["bash", str(script), command], capture_output=True, text=True,
                            env={**os.environ, "PATH": tmp + os.pathsep + os.environ["PATH"], "GUARD_SCENARIO": scenario}, timeout=5)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn(reason, result.stderr)


if __name__ == "__main__":
    unittest.main()
