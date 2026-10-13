# Trainer (default CMD) for RelayQ's ml.retrain: `docker run -e DATA_URL=... pulseboard-ml-eta`
# Server: `docker run -p 8000:8000 pulseboard-ml-eta uvicorn eta.serve:app --host 0.0.0.0`
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml .
COPY eta eta
RUN PIP_DEFAULT_TIMEOUT=120 pip install --no-cache-dir .
ENV MODEL_DIR=/models
CMD ["python", "-m", "eta.train"]
