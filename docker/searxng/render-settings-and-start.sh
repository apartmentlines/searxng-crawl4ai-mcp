#!/bin/sh
set -eu

template="/etc/searxng/settings.yml.template"
rendered="/etc/searxng/settings.yml"

python /usr/local/bin/render_searxng_settings.py "$template" "$rendered"

exec /usr/local/searxng/entrypoint.sh "$@"
