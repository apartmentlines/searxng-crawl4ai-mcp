#!/usr/bin/env python3

import os
import re
import sys

if len(sys.argv) != 3:
    raise SystemExit("usage: render_searxng_settings.py TEMPLATE OUTPUT")

template_path, output_path = sys.argv[1], sys.argv[2]

required = {
    "SEARXNG_SECRET",
    "SEARXNG_PROXY_USER",
    "SEARXNG_PROXY_PASSWORD_URLENCODED",
}

missing = sorted(name for name in required if not os.environ.get(name))
if missing:
    raise SystemExit(f"missing required environment variables: {', '.join(missing)}")

pattern = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")

def replace(match: re.Match[str]) -> str:
    name = match.group(1)
    if name not in os.environ:
        raise SystemExit(f"missing environment variable used in template: {name}")
    return os.environ[name]

with open(template_path, "r", encoding="utf-8") as f:
    rendered = pattern.sub(replace, f.read())

with open(output_path, "w", encoding="utf-8") as f:
    f.write(rendered)
