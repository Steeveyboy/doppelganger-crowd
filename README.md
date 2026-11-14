# Doppelganger Crowd

Browser multiplayer social-deduction game. Everyone controls one figure in a crowd of identical NPC "doppels". Do your errands, blend in, and unmask the other humans.

## Run locally
    npm install
    npm start            # http://localhost:3000 — open several tabs to test

## Controls
- WASD / arrows to move, or left-click a spot to walk there. Shift = stroll.
- Hover a figure + Space (or right-click) to tag it. You must be within the dashed circle.

## Scoring
Task +1, complete set +2, catch a human +5, last human standing +3, wrong tag −1 + 6s lockout.

## Deploy (Railway)
    npx @railway/cli login
    npx @railway/cli init
    npx @railway/cli up
    npx @railway/cli domain   # prints your public URL
