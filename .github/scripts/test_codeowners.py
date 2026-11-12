"""CODEOWNERS가 parts.json과 같은 말을 하는지 본다."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class CodeownersTest(unittest.TestCase):
    def test_every_part_path_has_its_owner(self):
        parts = json.loads((ROOT / ".github/parts.json").read_text())["parts"]
        owners = {}
        for line in (ROOT / ".github/CODEOWNERS").read_text().splitlines():
            if line.strip() and not line.startswith("#"):
                path, *who = line.split()
                owners[path] = who
        for key, part in parts.items():
            for path in part["paths"]:
                self.assertEqual(owners.get("/" + path), ["@" + part["owner"]], f"{key}: /{path}")


if __name__ == "__main__":
    unittest.main()
