from PIL import Image, ImageDraw


def make_icon(size, path):
    # 紫→コーラルのポップなグラデーション背景
    img = Image.new("RGB", (size, size), "#6c5ce7")
    d = ImageDraw.Draw(img)
    top = (108, 92, 231)
    bottom = (255, 107, 107)
    for y in range(size):
        t = y / max(size - 1, 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=color)

    # 白い吹き出し
    pad = size * 0.2
    d.rounded_rectangle(
        [pad, pad * 0.95, size - pad, size - pad * 1.35],
        radius=size * 0.15,
        fill="#ffffff",
    )
    d.polygon(
        [
            (size * 0.34, size - pad * 1.36),
            (size * 0.46, size - pad * 1.36),
            (size * 0.32, size - pad * 0.5),
        ],
        fill="#ffffff",
    )

    # 中の3つのドット
    r = size * 0.042
    cy = size * 0.45
    for cx, color in (
        (size * 0.38, "#6c5ce7"),
        (size * 0.5, "#ff6b6b"),
        (size * 0.62, "#fdcb6e"),
    ):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)

    img.save(path)


make_icon(192, "icons/icon-192.png")
make_icon(512, "icons/icon-512.png")
print("done")
