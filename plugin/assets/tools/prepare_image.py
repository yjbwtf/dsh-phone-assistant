import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src)
if im.mode not in ('RGB', 'L'):
    im = im.convert('RGB')
elif im.mode == 'L':
    im = im.convert('RGB')
im.thumbnail((1600, 1600), Image.LANCZOS)
im.save(dst, 'JPEG', quality=88, optimize=True)
print(dst)
