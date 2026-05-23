from __future__ import annotations

"""Patch SearXNG's Startpage engine to submit the live homepage form."""

import argparse
import logging
from pathlib import Path


DEFAULT_TARGET = Path("/usr/local/searxng/searx/engines/startpage.py")

ORIGINAL_HELPER_BLOCK = '''sc_code_cache_sec = 3600
"""Time in seconds the sc-code is cached in memory :py:obj:`get_sc_code`."""


def get_sc_code(params):
    """Get an actual ``sc`` argument from Startpage's search form (HTML page).

    Startpage puts a ``sc`` argument on every HTML :py:obj:`search form
    <search_form_xpath>`.  Without this argument Startpage considers the request
    is from a bot.  We do not know what is encoded in the value of the ``sc``
    argument, but it seems to be a kind of a *timestamp*.

    Startpage's search form generates a new sc-code on each request.  This
    function scrapes a new sc-code from Startpage's home page every
    :py:obj:`sc_code_cache_sec` seconds."""

    sc_code = CACHE.get("SC_CODE")
    if sc_code:
        logger.debug("get_sc_code: using cached value: %s", sc_code)
        return sc_code

    get_sc_url = base_url + "/"
    logger.debug("get_sc_code: querying new sc timestamp @ %s", get_sc_url)

    headers = {**params["headers"]}
    logger.debug("get_sc_code: request headers: %s", headers)
    resp = get(get_sc_url, headers=headers)

    # ?? x = network.get('https://www.startpage.com/sp/cdn/images/filter-chevron.svg', headers=headers)
    # ?? https://www.startpage.com/sp/cdn/images/filter-chevron.svg
    # ?? ping-back URL: https://www.startpage.com/sp/pb?sc=TLsB0oITjZ8F21

    if str(resp.url).startswith("https://www.startpage.com/sp/captcha"):
        raise SearxEngineCaptchaException(
            message="get_sc_code: got redirected to https://www.startpage.com/sp/captcha",
        )

    dom = lxml.html.fromstring(resp.text)

    try:
        sc_code = eval_xpath(dom, search_form_xpath + '//input[@name="sc"]/@value')[0]
    except IndexError as exc:
        logger.debug("suspend startpage API --> https://github.com/searxng/searxng/pull/695")
        raise SearxEngineCaptchaException(
            message="get_sc_code: [PR-695] querying new sc timestamp failed! (%s)" % resp.url,
        ) from exc

    sc_code = str(sc_code)
    logger.debug("get_sc_code: new value is: %s", sc_code)
    CACHE.set(key="SC_CODE", value=sc_code, expire=sc_code_cache_sec)
    return sc_code
'''

PATCHED_HELPER_BLOCK = '''def get_startpage_form(params):
    """Fetch Startpage's homepage form data and cookies."""

    form_url = base_url + "/"
    logger.debug("get_startpage_form: querying form @ %s", form_url)

    headers = {**params["headers"]}
    logger.debug("get_startpage_form: request headers: %s", headers)
    resp = get(form_url, headers=headers)

    if str(resp.url).startswith("https://www.startpage.com/sp/captcha"):
        raise SearxEngineCaptchaException(
            message="get_startpage_form: got redirected to https://www.startpage.com/sp/captcha",
        )

    params["cookies"].update(resp.cookies)
    dom = lxml.html.fromstring(resp.text)

    form = eval_xpath(dom, search_form_xpath)
    if not form:
        logger.debug("suspend startpage API --> https://github.com/searxng/searxng/pull/695")
        raise SearxEngineCaptchaException(
            message="get_startpage_form: querying Startpage search form failed! (%s)" % resp.url,
        )

    args = {}
    for input_node in eval_xpath(form[0], './/input[@name]'):
        args[input_node.get("name")] = input_node.get("value", "")

    action = form[0].get("action", "/sp/search")
    url = action if action.startswith("http") else base_url + action

    return args, url
'''

ORIGINAL_REQUEST_BLOCK = '''    engine_region = traits.get_region(params["searxng_locale"], "en-US")
    engine_language = traits.get_language(params["searxng_locale"], "en")

    params["headers"]["Origin"] = base_url
    params["headers"]["Referer"] = base_url + "/"

    # Build form data
    args = {
        "query": query,
        "cat": startpage_categ,
        "t": "device",
        "sc": get_sc_code(params),
        "with_date": time_range_dict.get(params["time_range"], ""),
        "abp": "1",
        "abd": "1",
        "abe": "1",
    }

    if engine_language:
        args["language"] = engine_language
        args["lui"] = engine_language

    if params["pageno"] > 1:
        args["page"] = params["pageno"]
        args["segment"] = "startpage.udog"

    # Build cookie
    lang_homepage = "en"
    cookie = OrderedDict()
    cookie["date_time"] = "world"
    cookie["disable_family_filter"] = safesearch_dict[params["safesearch"]]
    cookie["disable_open_in_new_window"] = "0"
    cookie["enable_post_method"] = "1"  # hint: POST
    cookie["enable_proxy_safety_suggest"] = "1"
    cookie["enable_stay_control"] = "1"
    cookie["instant_answers"] = "1"
    cookie["lang_homepage"] = "s/device/%s/" % lang_homepage
    cookie["num_of_results"] = "10"
    cookie["suggestions"] = "1"
    cookie["wt_unit"] = "celsius"

    if engine_language:
        cookie["language"] = engine_language
        cookie["language_ui"] = engine_language

    if engine_region:
        cookie["search_results_region"] = engine_region

    params["cookies"]["preferences"] = "N1N".join(["%sEEE%s" % x for x in cookie.items()])
    logger.debug("cookie preferences: %s", params["cookies"]["preferences"])

    logger.debug("data: %s", args)
    params["data"] = args
    params["method"] = "POST"
    params["url"] = search_url
'''

PATCHED_REQUEST_BLOCK = '''    engine_language = traits.get_language(params["searxng_locale"], "en")

    params["headers"]["Origin"] = base_url
    params["headers"]["Referer"] = base_url + "/"

    args, url = get_startpage_form(params)
    args["query"] = query
    args["cat"] = startpage_categ
    args["with_date"] = time_range_dict.get(params["time_range"], "")

    if engine_language:
        args["language"] = engine_language
        args["lui"] = engine_language

    if params["pageno"] > 1:
        args["page"] = params["pageno"]
        args["segment"] = "startpage.udog"

    logger.debug("data: %s", args)
    params["data"] = args
    params["method"] = "POST"
    params["url"] = url
'''


class StartpageFormPatcher:
    """Apply the local Startpage live-form patch."""

    def __init__(self, target: Path) -> None:
        self.target = target

    def apply(self) -> bool:
        content = self.target.read_text()

        if PATCHED_HELPER_BLOCK in content and PATCHED_REQUEST_BLOCK in content:
            logging.info("%s already submits Startpage's live homepage form", self.target)
            self.purge_cached_bytecode()
            return False

        patched_content = self.patch_content(content)
        self.target.write_text(patched_content)
        self.purge_cached_bytecode()
        logging.info("Patched Startpage live form submission in %s", self.target)
        return True

    def patch_content(self, content: str) -> str:
        if PATCHED_HELPER_BLOCK not in content:
            if ORIGINAL_HELPER_BLOCK not in content:
                raise RuntimeError(
                    f"Could not patch {self.target}: expected Startpage sc-code helper was not found"
                )
            content = content.replace(ORIGINAL_HELPER_BLOCK, PATCHED_HELPER_BLOCK)

        if PATCHED_REQUEST_BLOCK not in content:
            if ORIGINAL_REQUEST_BLOCK not in content:
                raise RuntimeError(
                    f"Could not patch {self.target}: expected Startpage request block was not found"
                )
            content = content.replace(ORIGINAL_REQUEST_BLOCK, PATCHED_REQUEST_BLOCK)

        return content

    def purge_cached_bytecode(self) -> None:
        cache_dir = self.target.parent / "__pycache__"
        if not cache_dir.exists():
            logging.debug("No bytecode cache directory found at %s", cache_dir)
            return

        for bytecode_file in cache_dir.glob(f"{self.target.stem}.*.pyc"):
            bytecode_file.unlink()
            logging.info("Removed cached bytecode %s", bytecode_file)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Patch SearXNG's Startpage engine to submit the live homepage form."
    )
    parser.add_argument(
        "--target",
        type=Path,
        default=DEFAULT_TARGET,
        help="Path to SearXNG's startpage.py file. Defaults to %(default)s",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging.",
    )
    return parser.parse_args()


def configure_logging(debug: bool) -> None:
    logging.basicConfig(
        format="%(levelname)s:%(message)s",
        level=logging.DEBUG if debug else logging.INFO,
    )


def main() -> int:
    args = parse_args()
    configure_logging(args.debug)
    StartpageFormPatcher(args.target).apply()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
