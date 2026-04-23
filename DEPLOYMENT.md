## GitHub Pages deployment

This repository can be deployed to GitHub Pages as a static frontend.

Important: GitHub Pages does not run Node.js servers, so `server.js` is not hosted there.
- You will still get the 3D client.
- Multiplayer/state sync requires a separate backend (Render, Railway, etc).

### 1. Use the correct repository name

To publish at:

https://graffiti-gamedk.github.io/

your repository must be named exactly:

`graffiti-gamedk.github.io`

If the repository has another name, the URL becomes:

https://graffiti-gamedk.github.io/<repo-name>/

### 2. Enable Pages in GitHub

In GitHub repository settings:
- Open `Settings > Pages`
- Under Build and deployment, set Source to `GitHub Actions`

### 3. Push to main

This repo includes `.github/workflows/deploy-pages.yml`.

On each push to `main`, it will:
- run `npm ci`
- run `npm run build:client`
- publish static files from `public/` plus `City.glb` and `models/`

### 4. Optional: connect a live backend

If you deploy backend separately, open your Pages URL with query params:

`?api=https://YOUR-BACKEND.example.com`

Examples:
- `https://graffiti-gamedk.github.io/?api=https://your-backend.onrender.com`
- `https://graffiti-gamedk.github.io/?api=https://your-backend.onrender.com&socket=https://your-backend.onrender.com`

If these params are missing, the app runs in offline frontend mode on Pages.
