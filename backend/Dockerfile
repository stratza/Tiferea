# TifEra backend image.
# In-cluster-only: running this image outside Kubernetes (e.g. `docker run`)
# exits non-zero within 5 s with an actionable error.

FROM python:3.12-slim

LABEL org.opencontainers.image.title="TifEra" \
      org.opencontainers.image.description="In-cluster-only Kubernetes operations console" \
      org.opencontainers.image.vendor="Stratza Labs" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/stratza/tiferea"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY tifera ./tifera
COPY static ./static

USER 65532:65532
EXPOSE 8080

ENTRYPOINT ["python", "-m", "tifera"]
