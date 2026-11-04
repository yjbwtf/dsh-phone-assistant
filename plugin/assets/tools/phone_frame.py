import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
im = im.resize((800, 450), Image.Resampling.LANCZOS)
im.save(dst, 'JPEG', quality=80, optimize=True)
print(dst)
