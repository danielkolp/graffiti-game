## GitHub Pages deployment

This repository can be deployed to GitHub Pages as a static frontend.

Important: GitHub Pages does not run Node.js servers, so `server.js` is not hosted there.
- You will still get the 3D client.
- Multiplayer/state sync requires a separate backend (Render, Railway, etc).

### 1. Use the correct URL shape

For GitHub Pages there are two common URL forms:

- User site (repo name must match account):
	- `https://<username>.github.io/`
	- repo must be named `<username>.github.io`
- Project site (any repo name):
	- `https://<username>.github.io/<repo-name>/`

For your current account this means:

- user site root: `https://danielkolp.github.io/`
- this project site (current repo): `https://danielkolp.github.io/graffiti-game/`

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
- `https://danielkolp.github.io/graffiti-game/?api=https://your-backend.onrender.com`
- `https://danielkolp.github.io/graffiti-game/?api=https://your-backend.onrender.com&socket=https://your-backend.onrender.com`

If these params are missing, the app runs in offline frontend mode on Pages.
