# VtiChess — Three Kingdoms

A browser-hosted three-player chess variant published as a static GitHub Pages site.

## Play online

1. Open the GitHub Pages site over HTTPS.
2. The first player chooses **Tạo phòng (Host)**. Their browser becomes the authoritative game server for that match.
3. Share **Copy link mời** with two other players.
4. The other two players open the link and choose **Tham gia**. The game starts when all three seats are connected.

## Network architecture

- The host browser owns the canonical game state and validates every move.
- The other players send move requests to the host and receive synchronized game snapshots.
- WebRTC data channels carry gameplay messages directly between browsers whenever the network permits.
- PeerJS Cloud is used only for initial peer signaling. Some restrictive networks/NATs can prevent a direct connection; those cases may require a TURN relay. A dedicated game server is not deployed by this repository.
- The host must keep the page open for the whole game. Closing the host tab ends the authoritative session.
- A guest disconnecting after the game starts is eliminated by this variant's house rule.

## Variant rules implemented

- Three armies: North (white), East (blue), and West (red).
- Turn order: North → East → West, skipping eliminated players.
- 12×12 cross-shaped play area, with pieces starting on the top, left, and right sides.
- Rook, bishop, queen, knight, king, and pawn use chess-like movement on the grid.
- Pawns move toward the center; captures are diagonal relative to their direction and promotion automatically becomes a queen at the opposite edge.
- The variant omits castling and en passant.
- A player with no legal move while in check is eliminated and all of that player's pieces are removed. A stalemated player skips their turn.
- The last remaining active player wins.

This is a custom three-player variant, not a complete reproduction of any official three-player chess ruleset.

## Local development

Because it is a static site, open `index.html` through a local HTTP server or GitHub Pages (HTTPS). Some browser APIs and WebRTC features may not work when opening the file directly with `file://`.

## Current limitations

- PeerJS Cloud and the selected public CDNs must be reachable.
- No dedicated backend, accounts, persistent leaderboard, reconnect/resume, private-room password, or guaranteed TURN relay is included.
- Stockfish/GPU evaluation is not part of this three-player multiplayer page; this build focuses on the three-player rules and P2P game hosting.
