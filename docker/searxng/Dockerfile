FROM searxng/searxng:latest

COPY patch_duckduckgo.py /tmp/patch_duckduckgo.py
RUN python /tmp/patch_duckduckgo.py && rm /tmp/patch_duckduckgo.py

COPY patch_yahoo_headers.py /tmp/patch_yahoo_headers.py
RUN python /tmp/patch_yahoo_headers.py && rm /tmp/patch_yahoo_headers.py

COPY patch_startpage_form.py /tmp/patch_startpage_form.py
RUN python /tmp/patch_startpage_form.py && rm /tmp/patch_startpage_form.py
