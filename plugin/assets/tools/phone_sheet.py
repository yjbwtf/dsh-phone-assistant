import json
import os
import sys
from PIL import Image, ImageChops, ImageDraw, ImageStat

out = sys.argv[1]
paths = sys.argv[2:]
if len(paths) < 1:
    raise SystemExit('no frames')

images = []
for path in paths:
    try:
        images.append(Image.open(path).convert('RGB'))
    except Exception:
        pass
if not images:
    raise SystemExit('no readable frames')

# Pick frames with visible change, but always keep the first and the latest.
signatures = [im.convert('L').resize((64, 64)) for im in images]
selected = [0]
scores = [0.0]
for index in range(1, len(images)):
    diff = ImageChops.difference(signatures[index - 1], signatures[index])
    score = float(ImageStat.Stat(diff).mean[0])
    scores.append(round(score, 2))
    if score >= 1.2:
        selected.append(index)
if len(images) > 1 and len(selected) < 2:
    selected.append(len(images) - 1)
if len(selected) < 2 and len(images) > 1:
    selected.append(len(images) - 1)
selected = sorted(set(selected))[:4]
# Keep the latest frame even when there are too many candidates.
if len(images) > 1 and len(selected) < 4 and (len(images) - 1) not in selected:
    selected.append(len(images) - 1)
    selected = sorted(set(selected))[:4]

tile_w = 360
tile_h = 780
header = 24
cols = 2 if len(selected) > 1 else 1
rows = (len(selected) + cols - 1) // cols
sheet = Image.new('RGB', (tile_w * cols, (tile_h + header) * rows), (18, 22, 28))
draw = ImageDraw.Draw(sheet)
for position, index in enumerate(selected):
    im = images[index].copy()
    im.thumbnail((tile_w, tile_h), Image.Resampling.LANCZOS)
    x = (position % cols) * tile_w + (tile_w - im.width) // 2
    y = (position // cols) * (tile_h + header) + header
    sheet.paste(im, (x, y))
    label = f'#{position + 1}  frame {index + 1}/{len(images)}  diff={scores[index]:.1f}'
    draw.text(((position % cols) * tile_w + 6, (position // cols) * (tile_h + header) + 4), label, fill=(180, 210, 230))

os.makedirs(os.path.dirname(out), exist_ok=True)
sheet.save(out, 'JPEG', quality=82, optimize=True)
print(json.dumps({
    'path': out,
    'frames': len(images),
    'selected': [index + 1 for index in selected],
    'scores': scores,
    'width': sheet.width,
    'height': sheet.height,
}, ensure_ascii=False))
