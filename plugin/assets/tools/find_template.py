import json
import sys
import cv2

# usage: find_template.py <screenshot> <template> [x y w h]
shot_path = sys.argv[1]
tpl_path = sys.argv[2]
roi = None
if len(sys.argv) >= 7:
    roi = tuple(int(v) for v in sys.argv[3:7])

img = cv2.imread(shot_path, cv2.IMREAD_GRAYSCALE)
tpl = cv2.imread(tpl_path, cv2.IMREAD_GRAYSCALE)
if img is None or tpl is None:
    print(json.dumps({"found": False, "error": "image load failed"}))
    sys.exit(0)

offset_x = offset_y = 0
if roi is not None:
    x, y, w, h = roi
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > img.shape[1] or y + h > img.shape[0]:
        print(json.dumps({"found": False, "error": "invalid roi"}))
        sys.exit(0)
    img = img[y:y + h, x:x + w]
    offset_x, offset_y = x, y

if tpl.shape[0] > img.shape[0] or tpl.shape[1] > img.shape[1]:
    print(json.dumps({"found": False, "error": "template larger than roi"}))
    sys.exit(0)

img_edges = cv2.Canny(img, 50, 150)
tpl_edges = cv2.Canny(tpl, 50, 150)
result = cv2.matchTemplate(img_edges, tpl_edges, cv2.TM_CCOEFF_NORMED)
_, max_val, _, max_loc = cv2.minMaxLoc(result)
center_x = offset_x + max_loc[0] + tpl.shape[1] // 2
center_y = offset_y + max_loc[1] + tpl.shape[0] // 2
print(json.dumps({
    "found": bool(max_val >= 0.32),
    "score": round(float(max_val), 4),
    "x": int(center_x),
    "y": int(center_y),
    "w": int(tpl.shape[1]),
    "h": int(tpl.shape[0]),
}))
