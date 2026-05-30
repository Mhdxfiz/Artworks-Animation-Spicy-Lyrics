# 🎨 Animated Artworks  for Spicy Lyrics

A Spicetify extension that brings your album artwork to life with smooth animations.

---

https://github.com/user-attachments/assets/7a0475dd-3c29-4c2b-99cb-8413c89243f2



## 📦 How to Install

### Step 1 — Install Spicetify Extension

Download `animated-artworks.mjs` and place it in:

```
C:\Users\YourName\AppData\Roaming\spicetify\Extensions
```

Then run these commands in PowerShell:

```powershell
spicetify config extensions animated-artwork.mjs
```

```powershell
spicetify apply
```

---

### Step 2 — Place Proxy File

Download `animart-proxy.js` and place it in:

```
C:\Windows\System32
```

---

### Step 3 — Install ffmpeg

> ⚠️ Run PowerShell **as Administrator** before running this command.

```powershell
winget install ffmpeg
```

Wait until ffmpeg is fully installed before proceeding to the next step.

---

### Step 4 — Run the Proxy

Once ffmpeg is installed, start the proxy:

```powershell
node animart-proxy.js
```

---
WORKING IN SPICY LYRICS✨🔥

## ✅ You're all set!

Enjoy your animated album artworks on Spotify. If you run into any issues, feel free to open an [issue](../../issues).
