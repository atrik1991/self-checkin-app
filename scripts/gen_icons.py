from PIL import Image, ImageDraw

def make_icon(size, path):
    img = Image.new("RGB", (size, size), "#3730a3")
    d = ImageDraw.Draw(img)
    # speech-bubble-ish rounded rect
    pad = size * 0.18
    d.rounded_rectangle(
        [pad, pad * 0.9, size - pad, size - pad * 1.4],
        radius=size * 0.14,
        fill="#ffffff",
    )
    # three dots (chat)
    r = size * 0.045
    cy = size * 0.47
    for cx in (size * 0.38, size * 0.5, size * 0.62):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill="#3730a3")
    # tail
    d.polygon(
        [
            (size * 0.32, size - pad * 1.4),
            (size * 0.42, size - pad * 1.4),
            (size * 0.30, size - pad * 0.55),
        ],
        fill="#ffffff",
    )
    img.save(path)

make_icon(192, "icons/icon-192.png")
make_icon(512, "icons/icon-512.png")
print("done")
