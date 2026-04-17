# Icons

Required files for PWA install:

- `icon-192.png` — 192×192, any/maskable
- `icon-512.png` — 512×512, any/maskable

Both are referenced from `manifest.json`. Until real icons are added, the app
still loads but the install prompt will be rejected on strict Android builds.

Quick placeholder:

```
# any solid-color PNG is fine for local testing
magick -size 192x192 xc:black icons/icon-192.png
magick -size 512x512 xc:black icons/icon-512.png
```
