"""
보행 신호 알리미 — YOLO WebSocket 추론 서버
CentOS 8 / Ryzen 7 3700X / CPU 전용
"""
import asyncio, base64, json, logging
import numpy as np
import cv2
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from ultralytics import YOLO

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── 모델 로드 (서버 시작 시 1회) ──
MODEL_PATH = '/opt/traffic-yolo/yolov8s.pt'
model = YOLO(MODEL_PATH)
model.predict(np.zeros((320, 320, 3), dtype=np.uint8), imgsz=320, verbose=False)  # 워밍업
logger.info('YOLOv8s loaded & warmed up')

app = FastAPI()

CLS_LIGHT  = 9
CLS_PERSON = 0
NEAR_THR   = 0.12
FAR_MIN    = 0.02
SCORE_NEAR = 0.45
SCORE_FAR  = 0.28

def parse_results(results, orig_w, orig_h):
    """YOLO 결과 → 정규화 박스 리스트"""
    detections = []
    if results.boxes is None:
        return detections

    boxes   = results.boxes.xyxy.cpu().numpy()   # [x1,y1,x2,y2] 픽셀
    scores  = results.boxes.conf.cpu().numpy()
    classes = results.boxes.cls.cpu().numpy().astype(int)

    for box, score, cls in zip(boxes, scores, classes):
        if cls not in (CLS_LIGHT, CLS_PERSON):
            continue
        x1, y1, x2, y2 = box
        # 원본 이미지 기준 정규화
        nx1 = x1 / orig_w
        ny1 = y1 / orig_h
        nx2 = x2 / orig_w
        ny2 = y2 / orig_h
        norm_h = ny2 - ny1
        if norm_h < FAR_MIN:
            continue
        is_near = norm_h >= NEAR_THR
        min_score = SCORE_NEAR if is_near else SCORE_FAR
        if score < min_score:
            continue
        detections.append({
            'cls':   int(cls),
            'score': float(score),
            'range': 'near' if is_near else 'far',
            'box':   [float(ny1), float(nx1), float(ny2), float(nx2)],
            'src':   'server',
        })
    return detections

def classify_signals(detections):
    """보행 신호등 판별 (person IoU > 0.1)"""
    lights  = [d for d in detections if d['cls'] == CLS_LIGHT]
    persons = [d for d in detections if d['cls'] == CLS_PERSON]

    def iou(a, b):
        iy1 = max(a[0], b[0]); ix1 = max(a[1], b[1])
        iy2 = min(a[2], b[2]); ix2 = min(a[3], b[3])
        inter = max(0, iy2-iy1) * max(0, ix2-ix1)
        if not inter:
            return 0
        return inter / ((a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter)

    for light in lights:
        is_ped = any(iou(light['box'], p['box']) > 0.1 for p in persons)
        light['isPedestrian'] = is_ped
        light['priority']     = 2 if is_ped else 1

    lights.sort(key=lambda x: (-x['priority'], -x['score']))
    return lights

@app.websocket('/ws')
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    client = ws.client
    logger.info(f'connected: {client}')
    try:
        while True:
            # 클라이언트에서 JPEG bytes 수신
            data = await ws.receive_bytes()

            # JPEG 디코딩
            arr = np.frombuffer(data, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                await ws.send_text(json.dumps({'signals': [], 'error': 'decode failed'}))
                continue

            orig_h, orig_w = img.shape[:2]

            # 추론 (CPU)
            loop    = asyncio.get_event_loop()
            results = await loop.run_in_executor(
                None,
                lambda: model.predict(img, imgsz=640, verbose=False)[0]
            )

            dets    = parse_results(results, orig_w, orig_h)
            signals = classify_signals(dets)

            await ws.send_text(json.dumps({'signals': signals}))

    except WebSocketDisconnect:
        logger.info(f'disconnected: {client}')
    except Exception as e:
        logger.error(f'error: {e}')
        try:
            await ws.send_text(json.dumps({'signals': [], 'error': str(e)}))
        except:
            pass

@app.get('/health')
def health():
    return {'status': 'ok', 'model': 'yolov8s'}
