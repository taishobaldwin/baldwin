# Repo layout (read before editing)

- The staff page (Daily Service Plan) lives in **the one top-level folder that contains `index.html`** (with its `images/`).
- The folder name is random and is changed every Sunday night by `rotate.sh` (that is how the link changes). Do not rename it yourself.
- The root `index.html` is only a blank placeholder so the old link shows nothing. Never put the page there.

- `worker/` + `.github/workflows/deploy.yml`: every push to main copies the page folder into the Cloudflare Worker and deploys it (the private DingTalk app). Do not edit these when updating the plan.
