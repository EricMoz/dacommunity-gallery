# Put the gallery on GitHub (one-time)

Your code is ready on your PC but **was never pushed** to GitHub. That is why you see 404 and no repo under [github.com/EricMoz](https://github.com/EricMoz).

## Step 1 — Log in to GitHub CLI (once)

Open **PowerShell** and run:

```powershell
gh auth login
```

Choose:

- **GitHub.com**
- **HTTPS**
- **Login with a web browser** (easiest)

## Step 2 — Create repo and push

```powershell
cd "C:\Users\ericm\OneDrive\Documents\dacat\daCommunity-Gallery"
.\scripts\create-github-repo.ps1
```

Or manually:

```powershell
cd "C:\Users\ericm\OneDrive\Documents\dacat\daCommunity-Gallery"
gh repo create dacommunity-gallery --public --source . --remote origin --push --description "daCAT daCommunity NFT gallery"
```

## Step 3 — Turn on GitHub Pages

1. Open **https://github.com/EricMoz/dacommunity-gallery**
2. **Settings** → **Pages**
3. Under **Build and deployment**, set **Source** to **GitHub Actions** (not “Deploy from branch”)
4. Wait 2–3 minutes for the **Deploy gallery to GitHub Pages** workflow to finish (green check on **Actions** tab)

## Your public URL

**https://ericmoz.github.io/dacommunity-gallery/**

(Repo name must be `dacommunity-gallery` for that URL.)

## Optional — auto-refresh OpenSea data in the cloud

**Settings** → **Secrets and variables** → **Actions** → **New repository secret**

- Name: `OPENSEA_API_KEY`
- Value: copy from `backend\.env`

Without this secret, the site still works using the JSON and images already in the repo.