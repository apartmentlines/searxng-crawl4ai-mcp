from __future__ import annotations

"""Patch SearXNG's DuckDuckGo parser to skip malformed result entries."""

import argparse
import logging
from pathlib import Path


DEFAULT_TARGET = Path("/usr/local/searxng/searx/engines/duckduckgo.py")

ORIGINAL_BLOCK = '''    # just select "web-result" and ignore results of class "result--ad result--ad--small"
    for div_result in eval_xpath(doc, '//div[@id="links"]/div[contains(@class, "web-result")]'):
        _title = eval_xpath(div_result, ".//h2/a")
        _content = eval_xpath_getindex(div_result, './/a[contains(@class, "result__snippet")]', 0, [])
        res.add(
            res.types.MainResult(
                title=extract_text(_title) or "",
                url=eval_xpath(div_result, ".//h2/a/@href")[0],
                content=extract_text(_content) or "",
            )
        )
'''

PATCHED_BLOCK = '''    # just select "web-result" and ignore results of class "result--ad result--ad--small"
    for div_result in eval_xpath(doc, '//div[@id="links"]/div[contains(@class, "web-result")]'):
        _title = eval_xpath(div_result, ".//h2/a")
        _url = eval_xpath(div_result, ".//h2/a/@href")
        _content = eval_xpath_getindex(div_result, './/a[contains(@class, "result__snippet")]', 0, [])

        if len(_title) == 0 or len(_url) == 0:
            continue

        res.add(
            res.types.MainResult(
                title=extract_text(_title) or "",
                url=_url[0],
                content=extract_text(_content) or "",
            )
        )
'''


class DuckDuckGoParserPatcher:
    """Apply the local DuckDuckGo parser hardening patch."""

    def __init__(self, target: Path) -> None:
        """Create a patcher for a SearXNG DuckDuckGo engine file.

        :param target: Path to SearXNG's duckduckgo.py file.
        :type target: Path
        """
        self.target = target

    def apply(self) -> bool:
        """Patch the target file if it still contains the upstream parser block.

        :return: True when the file was changed, False when already patched.
        :rtype: bool
        :raises RuntimeError: If the expected upstream block is not present.
        """
        content = self.target.read_text()

        if PATCHED_BLOCK in content:
            logging.info("%s already contains DuckDuckGo parser guard", self.target)
            self.purge_cached_bytecode()
            return False

        if ORIGINAL_BLOCK not in content:
            raise RuntimeError(
                f"Could not patch {self.target}: expected DuckDuckGo parser block was not found"
            )

        self.target.write_text(content.replace(ORIGINAL_BLOCK, PATCHED_BLOCK))
        self.purge_cached_bytecode()
        logging.info("Patched DuckDuckGo parser guard in %s", self.target)
        return True

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
        description="Patch SearXNG's DuckDuckGo parser to skip malformed results."
    )
    parser.add_argument(
        "--target",
        type=Path,
        default=DEFAULT_TARGET,
        help="Path to SearXNG's duckduckgo.py file. Defaults to %(default)s",
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
    """Run the DuckDuckGo parser patcher.

    :return: Process exit code.
    :rtype: int
    """
    args = parse_args()
    configure_logging(args.debug)
    DuckDuckGoParserPatcher(args.target).apply()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
