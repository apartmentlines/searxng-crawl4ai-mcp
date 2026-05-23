from __future__ import annotations

"""Patch SearXNG's Yahoo engine to honor per-engine configured headers."""

import argparse
import logging
from pathlib import Path


DEFAULT_TARGET = Path("/usr/local/searxng/searx/engines/yahoo.py")

ORIGINAL_IMPORT_BLOCK = """from searx.utils import (
    eval_xpath_getindex,
    eval_xpath_list,
    extract_text,
    html_to_text,
)
"""

PATCHED_IMPORT_BLOCK = """from searx.utils import (
    eval_xpath_getindex,
    eval_xpath_list,
    extract_text,
    html_to_text,
)

headers = {}
"""

ORIGINAL_REQUEST_BLOCK = """    logger.debug(f'domain selected: {domain}')
    logger.debug(f'cookies: {params["cookies"]}')

    params['url'] = f'https://{domain}/search?{urlencode(url_params)}'
    params['domain'] = domain
"""

PATCHED_REQUEST_BLOCK = """    logger.debug(f'domain selected: {domain}')
    logger.debug(f'cookies: {params["cookies"]}')

    params['headers'].update(headers)
    params['url'] = f'https://{domain}/search?{urlencode(url_params)}'
    params['domain'] = domain
"""


class YahooHeadersPatcher:
    """Apply the local Yahoo configured-headers patch."""

    def __init__(self, target: Path) -> None:
        """Create a patcher for a SearXNG Yahoo engine file.

        :param target: Path to SearXNG's yahoo.py file.
        :type target: Path
        """
        self.target = target

    def apply(self) -> bool:
        """Patch the target file if configured headers are not yet supported.

        :return: True when the file was changed, False when already patched.
        :rtype: bool
        :raises RuntimeError: If an expected upstream block is not present.
        """
        content = self.target.read_text()

        if PATCHED_IMPORT_BLOCK in content and PATCHED_REQUEST_BLOCK in content:
            logging.info("%s already honors configured Yahoo headers", self.target)
            self.purge_cached_bytecode()
            return False

        patched_content = self.patch_content(content)
        self.target.write_text(patched_content)
        self.purge_cached_bytecode()
        logging.info("Patched Yahoo configured headers in %s", self.target)
        return True

    def patch_content(self, content: str) -> str:
        """Apply the configured-headers changes to Yahoo engine source text.

        :param content: Current yahoo.py source text.
        :type content: str
        :return: Patched yahoo.py source text.
        :rtype: str
        :raises RuntimeError: If an expected upstream block is not present.
        """
        if PATCHED_IMPORT_BLOCK not in content:
            if ORIGINAL_IMPORT_BLOCK not in content:
                raise RuntimeError(
                    f"Could not patch {self.target}: expected Yahoo import block was not found"
                )
            content = content.replace(ORIGINAL_IMPORT_BLOCK, PATCHED_IMPORT_BLOCK)

        if PATCHED_REQUEST_BLOCK not in content:
            if ORIGINAL_REQUEST_BLOCK not in content:
                raise RuntimeError(
                    f"Could not patch {self.target}: expected Yahoo request block was not found"
                )
            content = content.replace(ORIGINAL_REQUEST_BLOCK, PATCHED_REQUEST_BLOCK)

        return content

    def purge_cached_bytecode(self) -> None:
        """Remove cached bytecode for the patched engine module.

        :return: None.
        :rtype: None
        """
        cache_dir = self.target.parent / "__pycache__"
        if not cache_dir.exists():
            logging.debug("No bytecode cache directory found at %s", cache_dir)
            return

        for bytecode_file in cache_dir.glob(f"{self.target.stem}.*.pyc"):
            bytecode_file.unlink()
            logging.info("Removed cached bytecode %s", bytecode_file)


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    :return: Parsed command-line arguments.
    :rtype: argparse.Namespace
    """
    parser = argparse.ArgumentParser(
        description="Patch SearXNG's Yahoo engine to honor configured headers."
    )
    parser.add_argument(
        "--target",
        type=Path,
        default=DEFAULT_TARGET,
        help="Path to SearXNG's yahoo.py file. Defaults to %(default)s",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging.",
    )
    return parser.parse_args()


def configure_logging(debug: bool) -> None:
    """Configure script logging.

    :param debug: Whether to enable debug logging.
    :type debug: bool
    """
    logging.basicConfig(
        format="%(levelname)s:%(message)s",
        level=logging.DEBUG if debug else logging.INFO,
    )


def main() -> int:
    """Run the Yahoo configured-headers patcher.

    :return: Process exit code.
    :rtype: int
    """
    args = parse_args()
    configure_logging(args.debug)
    YahooHeadersPatcher(args.target).apply()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
