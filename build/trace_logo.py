# Emre'nin logosunu (assets/cude_logo.png) birebir izleyip SVG yollarına çevirir; renkli sürümleri yazar.
import cv2, sys, os
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
img = cv2.imread(os.path.join(root, 'assets', 'cude_logo.png'), cv2.IMREAD_GRAYSCALE)
_, bw = cv2.threshold(img, 128, 255, cv2.THRESH_BINARY)
cnts, _ = cv2.findContours(bw, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
x0, y0, w, h = cv2.boundingRect(cv2.vconcat([c for c in cnts]))
pad = int(max(w, h) * 0.06); side = max(w, h) + 2 * pad
ox, oy = x0 - (side - w) // 2, y0 - (side - h) // 2
d = []
for c in cnts:
    c = cv2.approxPolyDP(c, 1.2, True)
    pts = [f"{p[0][0]-ox},{p[0][1]-oy}" for p in c]
    d.append('M' + ' L'.join(pts) + 'Z')
path = ' '.join(d)
def svg(color):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 {side} {side}">'
            f'<path fill="{color}" fill-rule="evenodd" d="{path}"/></svg>')
out = {'cude-mark.svg': '#ffffff', 'letterpress-dark.svg': '#2b2c29', 'letterpress-hcDark.svg': '#3a3a3a',
       'letterpress-light.svg': '#d9d9d5', 'letterpress-hcLight.svg': '#cfcfcf'}
for name, col in out.items():
    open(os.path.join(root, 'assets', name), 'w', encoding='utf-8').write(svg(col))
print('contours', len(cnts), 'side', side, 'bytes', len(path))
