"""FastAPI service that wraps Crawl4AI scraping for the MCP server."""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlparse

import httpx
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
from crawl4ai.models import AsyncCrawlResponse
from crawl4ai.processors.pdf import PDFContentScrapingStrategy, PDFCrawlerStrategy
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

PDF_MAGIC = b"%PDF-"
SNIFF_BYTES = 4096
FALLBACK_SCRAPE_TIMEOUT_MS = 10000
FALLBACK_BATCH_TIMEOUT_MS = 45000


def parse_positive_integer_env(name: str, fallback: int) -> int:
    """:param name: Environment variable name.
    :type name: str
    :param fallback: Value to use when the variable is unset or invalid.
    :type fallback: int
    :return: Parsed positive integer value.
    :rtype: int
    """

    raw_value = os.getenv(name)
    if not raw_value:
        return fallback

    try:
        parsed_value = int(raw_value)
    except ValueError:
        return fallback

    return parsed_value if parsed_value > 0 else fallback


DEFAULT_TIMEOUT_MS = parse_positive_integer_env(
    "CRAWL4AI_SCRAPE_TIMEOUT_MS",
    FALLBACK_SCRAPE_TIMEOUT_MS,
)
DEFAULT_BATCH_TIMEOUT_MS = parse_positive_integer_env(
    "CRAWL4AI_BATCH_TIMEOUT_MS",
    FALLBACK_BATCH_TIMEOUT_MS,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Crawl4AI Service", version="1.0.0")


class ScrapeRequest(BaseModel):
    url: str
    formats: list[str] | None = Field(default_factory=lambda: ["markdown"])
    wait_for: int | None = 0
    timeout: int | None = DEFAULT_TIMEOUT_MS
    proxy_url: str | None = None


class BatchScrapeRequest(BaseModel):
    urls: list[str]
    formats: list[str] | None = Field(default_factory=lambda: ["markdown"])
    concurrency: int | None = 3
    timeout: int | None = DEFAULT_BATCH_TIMEOUT_MS


class ExtractRequest(BaseModel):
    url: str
    prompt: str
    schema: dict[str, Any] | None = None


@dataclass(frozen=True)
class UrlInspection:
    original_url: str
    final_url: str
    headers: dict[str, str]
    first_bytes: bytes
    is_pdf: bool


class SafePDFCrawlerStrategy(PDFCrawlerStrategy):
    """PDF crawler strategy with non-empty placeholder HTML for Crawl4AI 0.8.6."""

    async def crawl(self, url: str, **kwargs: Any) -> AsyncCrawlResponse:
        """:param url: URL to pass to the PDF scraping strategy.
        :type url: str
        :param kwargs: Crawl4AI crawler parameters.
        :type kwargs: Any
        :return: Minimal PDF crawl response that avoids near-empty anti-bot checks.
        :rtype: AsyncCrawlResponse
        """

        return AsyncCrawlResponse(
            html=(
                "<!doctype html><html><head><title>PDF document</title></head>"
                "<body><main><article>"
                "<h1>PDF document</h1>"
                "<p>This placeholder allows Crawl4AI to route the request through "
                "its PDF content extraction strategy without treating the PDF "
                "crawler response as an empty browser-rendered page.</p>"
                "<p>The PDFContentScrapingStrategy downloads and parses the "
                "original PDF URL, then returns extracted text, metadata, links, "
                "and media through the normal Crawl4AI result object.</p>"
                "</article></main></body></html>"
            ),
            response_headers={"Content-Type": "application/pdf"},
            status_code=200,
        )


browser_crawler: AsyncWebCrawler | None = None


class Crawl4AIService:
    """Coordinates URL inspection and Crawl4AI scraping strategies."""

    def __init__(self) -> None:
        self.logger = logger

    async def inspect_url(self, url: str, timeout_ms: int) -> UrlInspection:
        """:param url: URL to inspect.
        :type url: str
        :param timeout_ms: Request timeout in milliseconds.
        :type timeout_ms: int
        :return: Inspection result with resolved URL, headers, and PDF verdict.
        :rtype: UrlInspection
        """

        timeout = max(timeout_ms / 1000, 1)
        final_url = url
        headers: dict[str, str] = {}
        first_bytes = b""

        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
            try:
                head_response = await client.head(url)
                final_url = str(head_response.url)
                headers.update(self._normalize_headers(head_response.headers))
            except httpx.HTTPError as error:
                self.logger.debug("HEAD inspection failed for %s: %s", url, error)

            try:
                async with client.stream(
                    "GET",
                    final_url,
                    headers={"Range": f"bytes=0-{SNIFF_BYTES - 1}"},
                ) as sniff_response:
                    final_url = str(sniff_response.url)
                    headers.update(self._normalize_headers(sniff_response.headers))
                    first_bytes = await self._read_first_bytes(sniff_response)
            except httpx.HTTPError as error:
                self.logger.debug("Range sniff failed for %s: %s", final_url, error)

        return UrlInspection(
            original_url=url,
            final_url=final_url,
            headers=headers,
            first_bytes=first_bytes,
            is_pdf=self.looks_like_pdf(headers, final_url, first_bytes),
        )

    def looks_like_pdf(
        self,
        headers: dict[str, str],
        final_url: str,
        first_bytes: bytes = b"",
    ) -> bool:
        """:param headers: Normalized response headers.
        :type headers: dict[str, str]
        :param final_url: URL after redirects.
        :type final_url: str
        :param first_bytes: Initial response body bytes.
        :type first_bytes: bytes
        :return: True when the response should be handled as a PDF.
        :rtype: bool
        """

        content_type = headers.get("content-type", "").lower()
        disposition = headers.get("content-disposition", "").lower()

        if first_bytes.startswith(PDF_MAGIC):
            return True
        if "application/pdf" in content_type:
            return True
        if ".pdf" in disposition:
            return True
        if self._url_path_ends_with_pdf(final_url) and not self._looks_like_html(
            headers,
            first_bytes,
        ):
            return True

        return False

    async def scrape_html(self, request: ScrapeRequest, url: str) -> Any:
        """:param request: Scrape request options.
        :type request: ScrapeRequest
        :param url: URL to scrape.
        :type url: str
        :return: Crawl4AI crawl result.
        :rtype: Any
        :raises HTTPException: If the browser crawler is unavailable.
        """

        if browser_crawler is None:
            raise HTTPException(status_code=500, detail="Crawler not initialized")

        return await browser_crawler.arun(
            url=url,
            word_count_threshold=10,
            wait_for=(request.wait_for or 0) / 1000,
        )

    async def scrape_pdf(self, url: str) -> Any:
        """:param url: PDF URL to scrape.
        :type url: str
        :return: Crawl4AI crawl result.
        :rtype: Any
        """

        run_config = CrawlerRunConfig(
            scraping_strategy=PDFContentScrapingStrategy(),
        )
        async with AsyncWebCrawler(crawler_strategy=SafePDFCrawlerStrategy()) as pdf_crawler:
            return await pdf_crawler.arun(url=url, config=run_config)

    def build_response(
        self,
        request: ScrapeRequest,
        result: Any,
        resolved_url: str,
    ) -> dict[str, Any]:
        """:param request: Original scrape request.
        :type request: ScrapeRequest
        :param result: Crawl4AI crawl result.
        :type result: Any
        :param resolved_url: Final URL used for scraping.
        :type resolved_url: str
        :return: API response payload.
        :rtype: dict[str, Any]
        """

        formats = request.formats or ["markdown"]
        cleaned_html = getattr(result, "cleaned_html", "") or ""
        markdown = self._markdown_text(getattr(result, "markdown", ""))
        if not markdown and cleaned_html:
            markdown = self._markdown_from_html(cleaned_html, resolved_url)
        metadata = getattr(result, "metadata", {}) or {}
        response_data: dict[str, Any] = {
            "success": True,
            "url": resolved_url,
            "data": {},
        }

        if "markdown" in formats:
            response_data["data"]["markdown"] = markdown
        if "html" in formats:
            response_data["data"]["html"] = cleaned_html
        if "links" in formats:
            response_data["data"]["links"] = getattr(result, "links", {})
        if "media" in formats:
            response_data["data"]["media"] = getattr(result, "media", {})

        response_data["data"]["metadata"] = {
            "title": metadata.get("title", ""),
            "description": metadata.get("description", ""),
            "language": metadata.get("language", ""),
            "word_count": len(markdown.split()) if markdown else 0,
        }
        return response_data

    def _normalize_headers(self, headers: httpx.Headers) -> dict[str, str]:
        return {key.lower(): value for key, value in headers.items()}

    def _url_path_ends_with_pdf(self, url: str) -> bool:
        parsed = urlparse(url)
        return unquote(parsed.path).lower().endswith(".pdf")

    def _looks_like_html(self, headers: dict[str, str], first_bytes: bytes) -> bool:
        content_type = headers.get("content-type", "").lower()
        stripped_bytes = first_bytes.lstrip().lower()
        return (
            "text/html" in content_type
            or stripped_bytes.startswith(b"<!doctype html")
            or stripped_bytes.startswith(b"<html")
        )

    async def _read_first_bytes(self, response: httpx.Response) -> bytes:
        chunks: list[bytes] = []
        remaining = SNIFF_BYTES

        async for chunk in response.aiter_bytes():
            if not chunk:
                continue
            chunks.append(chunk[:remaining])
            remaining -= len(chunks[-1])
            if remaining <= 0:
                break

        return b"".join(chunks)

    def _markdown_text(self, markdown: Any) -> str:
        if markdown is None:
            return ""
        raw_markdown = getattr(markdown, "raw_markdown", None)
        if isinstance(raw_markdown, str):
            return raw_markdown
        if isinstance(markdown, str):
            return str(markdown)
        return str(markdown)

    def _markdown_from_html(self, cleaned_html: str, base_url: str) -> str:
        markdown_result = DefaultMarkdownGenerator().generate_markdown(
            input_html=cleaned_html,
            base_url=base_url,
        )
        return markdown_result.raw_markdown or ""


service = Crawl4AIService()


@app.on_event("startup")
async def startup_event() -> None:
    global browser_crawler

    proxy_url = os.getenv("PROXY_URL")
    browser_args = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
    ]

    if proxy_url:
        browser_args.append(f"--proxy-server={proxy_url}")
        safe_proxy = (
            proxy_url.split("@", maxsplit=1)[1] if "@" in proxy_url else proxy_url
        )
        logger.info("Using proxy: %s", safe_proxy)

    browser_crawler = AsyncWebCrawler(
        browser_type="chromium",
        headless=True,
        browser_args=browser_args,
    )
    logger.info("Crawl4AI service started")


@app.on_event("shutdown")
async def shutdown_event() -> None:
    logger.info("Crawl4AI service stopped")


@app.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok", "service": "crawl4ai"}


@app.post("/scrape")
async def scrape_url(request: ScrapeRequest) -> dict[str, Any]:
    try:
        timeout_ms = request.timeout or DEFAULT_TIMEOUT_MS
        inspection = await service.inspect_url(request.url, timeout_ms)
        logger.info(
            "Scraping %s as %s",
            inspection.final_url,
            "pdf" if inspection.is_pdf else "html",
        )

        if inspection.is_pdf:
            scrape_task = service.scrape_pdf(inspection.final_url)
        else:
            scrape_task = service.scrape_html(request, inspection.final_url)

        try:
            result = await asyncio.wait_for(scrape_task, timeout=timeout_ms / 1000)
        except TimeoutError as error:
            raise HTTPException(
                status_code=504,
                detail=f"Scraping timed out after {timeout_ms}ms",
            ) from error

        if not result.success:
            raise HTTPException(
                status_code=400,
                detail=f"Scraping failed: {result.error_message}",
            )

        return service.build_response(request, result, inspection.final_url)

    except HTTPException:
        raise
    except Exception as error:
        logger.error("Error scraping %s: %s", request.url, error)
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/batch-scrape")
async def batch_scrape_urls(request: BatchScrapeRequest) -> dict[str, Any]:
    try:
        concurrency = min(request.concurrency or 3, 5)
        semaphore = asyncio.Semaphore(concurrency)

        async def scrape_single(url: str) -> dict[str, Any]:
            async with semaphore:
                scrape_request = ScrapeRequest(
                    url=url,
                    formats=request.formats,
                    timeout=request.timeout,
                )
                return await scrape_url(scrape_request)

        tasks = [scrape_single(url) for url in request.urls]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        successful_results = []
        for index, result in enumerate(results):
            if isinstance(result, Exception):
                logger.error("Error scraping %s: %s", request.urls[index], result)
                successful_results.append(
                    {
                        "success": False,
                        "url": request.urls[index],
                        "error": str(result),
                    },
                )
            else:
                successful_results.append(result)

        return {
            "success": True,
            "total": len(request.urls),
            "results": successful_results,
        }

    except Exception as error:
        logger.error("Error in batch scraping: %s", error)
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/extract")
async def extract_data(request: ExtractRequest) -> dict[str, Any]:
    try:
        if browser_crawler is None:
            raise HTTPException(status_code=500, detail="Crawler not initialized")

        result = await browser_crawler.arun(
            url=request.url,
            word_count_threshold=10,
        )

        if not result.success:
            raise HTTPException(
                status_code=400,
                detail=f"Extraction failed: {result.error_message}",
            )

        return {
            "success": True,
            "url": request.url,
            "extracted_data": result.extracted_content,
        }

    except HTTPException:
        raise
    except Exception as error:
        logger.error("Error extracting from %s: %s", request.url, error)
        raise HTTPException(status_code=500, detail=str(error)) from error


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
