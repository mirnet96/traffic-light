FROM python:3.11-slim

WORKDIR /app

# 시스템 패키지 (OpenCV 의존성)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libsm6 libxrender1 libxext6 \
    && rm -rf /var/lib/apt/lists/*

# Python 패키지
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 앱 코드 + 모델
COPY server.py .
COPY yolov8s.pt .

# 워밍업 시 모델 다운로드 방지 (로컬 pt 사용)
ENV YOLO_CONFIG_DIR=/app/.yolo

EXPOSE 8765

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8765"]
