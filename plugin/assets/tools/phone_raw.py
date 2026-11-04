import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
im = im.resize((800, 450), Image.Resampling.LANCZOS)
with open(dst, 'wb') as handle:
    handle.write(im.tobytes())
