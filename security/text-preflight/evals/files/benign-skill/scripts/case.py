#!/usr/bin/env python3
"""Benign eval fixture: pure text case conversion. Read-only, stdlib only."""
import sys


def main(argv):
    if len(argv) != 3 or argv[1] not in ("upper", "lower"):
        print("usage: case.py upper|lower <input-file>")
        return 1
    mode, path = argv[1], argv[2]
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    print(text.upper() if mode == "upper" else text.lower(), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
