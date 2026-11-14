# Doppelganger Crowd

Browser multiplayer social-deduction game. Everyone controls one figure in a crowd of identical NPC "doppels". Do your errands, blend in, and unmask the other humans.

## Run locally
    npm install
    npm start            # http://localhost:3000 — open several tabs to test

## Controls
- WASD / arrows to move (screen-relative), or left-click a spot to walk there. Hold C to stroll.
- Shift = dash: short speed burst, 8s cooldown. Doppels rarely move that fast, so dashing can give you away.
- R = airstrike at the mouse position: costs 3 points, 40s cooldown, lands after a 2.5s warning everyone can see.
- Hover a figure + Space (or right-click) to tag it. You must be within the dashed circle.

## Scoring
Task +1, complete set +2, catch a human +5 (tag or airstrike), last human standing +3, wrong tag −1 + 6s lockout, each doppel hit by your airstrike −1.

## Deploy (Railway)
    npx @railway/cli login
    npx @railway/cli init
    npx @railway/cli up
    npx @railway/cli domain   # prints your public URL
