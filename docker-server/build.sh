cd /home/docker/yolov8s
docker build -t traffic-yolo .
docker run -d \
  --name traffic-yolo \
  --restart always \
  -p 127.0.0.1:8765:8765 \
  traffic-yolo

# 확인
curl http://localhost:8765/health
