// ==UserScript==
// @name         Omoggle Score Packet Interceptor
// @namespace    https://omoggle.com/
// @version      12.0.0
// @description  u.e/i.e finalize manipulation + outgoing boost + clean passthrough for incoming
// @match        https://omoggle.com/*
// @match        https://*.omoggle.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        enabled: true,
        myScoreBoost: 1.84,
        myFinalScore: "94000",
        oppFinalScore: "15000",
        frameCap: 99000,
        // Live boost mode: 'multiplier' | 'range'
        boostMode: 'multiplier',
        boostRangeMin: 1.0,
        boostRangeMax: 2.5,
        // Final score mode: 'fixed' | 'range'
        finalScoreMode: 'fixed',
        finalScoreRangeMin: 85000,
        finalScoreRangeMax: 97000,
        boostPercent: 50,
        boostRandom: 10,         // ± random variance percent
        boostDuration: 1000,
        holdBtnSize: 54,
        debug: true,
        wmAlpha: 20,
        wmFontSize: 9,
        wmPaddingH: 14,
        wmPaddingV: 6,
        wmBorder: true,
        wmBg: true
    };

    let playerMapping = null;
    let _isRanked = window.location.pathname.startsWith('/ranked');

    // Lock in ranked mode the moment we see a ranked frame or URL
    const _origPushState = history.pushState;
    history.pushState = function(...args) {
        _origPushState.apply(this, args);
        _isRanked = window.location.pathname.startsWith('/ranked');
    };
    window.addEventListener('popstate', () => {
        _isRanked = window.location.pathname.startsWith('/ranked');
    });


    function tryDecode(data) {
        try {
            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            if (!(bytes instanceof Uint8Array)) return null;
            const text = new TextDecoder().decode(bytes);
            const jsonMatch = text.match(/\{[^}]+\}/);
            if (jsonMatch) return { json: JSON.parse(jsonMatch[0]), bytes, fullText: text };
        } catch (e) {}
        return null;
    }

    function rewriteBytes(originalBytes, oldJSON, newJSON) {
        const originalText = new TextDecoder().decode(originalBytes);
        const newText = originalText.replace(JSON.stringify(oldJSON), JSON.stringify(newJSON));
        return new TextEncoder().encode(newText);
    }

    // ── OUTGOING DataChannel — boost your q score for live display ────────────
    const originalSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data) {
        const parsed = tryDecode(data);
        if (parsed?.json) {
            const { json, bytes } = parsed;

            const hasP = typeof json.p !== 'undefined';
            const hasQ = typeof json.q !== 'undefined';
            // Normal frame: {p, q} only — no m field, no type
            const isNormalFrame = hasP && hasQ && json.m === undefined && !json.type;
            // Ranked frame: {p, q, m} — m contains face metrics
            const isRankedFrame = hasP && hasQ && json.m !== undefined;

            // Use packet structure to lock in ranked detection
            if (isRankedFrame && !_isRanked) {
                _isRanked = true;
                log('🔒 Locked: RANKED mode (m field detected in frame)');
            }

            if (isNormalFrame || isRankedFrame) {
                if (!playerMapping && json.q > 0) {
                    playerMapping = { myKey: 'q' };
                    log(`📌 q confirmed as your score [${isRankedFrame ? 'RANKED' : 'NORMAL'} frame]`);
                }
                if (json.q > 0) {
                    const modified = { ...json };
                    let _liveBoost;
                    if (CONFIG.boostMode === 'range') {
                        _liveBoost = CONFIG.boostRangeMin + Math.random() * (CONFIG.boostRangeMax - CONFIG.boostRangeMin);
                    } else {
                        _liveBoost = CONFIG.myScoreBoost * _boostMultiplier;
                    }
                    modified.q = Math.min(Math.round(json.q * _liveBoost), CONFIG.frameCap);
                    // Preserve m field exactly — server cross-validates it
                    if (json.m !== undefined) modified.m = json.m;
                    if (json.type !== undefined) modified.type = json.type;

                    log(`📤 [${isRankedFrame ? 'RANKED' : 'NORMAL'}] frame=${json.p} q: ${json.q}→${modified.q} (${(json.q/10000).toFixed(2)}→${(modified.q/10000).toFixed(2)})`);
                    _lastSpoofedScore = modified.q / 10000;
                    spoofPanel();
                    return originalSend.call(this, rewriteBytes(bytes, json, modified));
                }
            }

            const isRankedScoreType = json.type === "RANKED_SCORE" && typeof json.score !== "undefined";
            if (isRankedScoreType) {
                const modified = { ...json };
                modified.score = Math.min(json.score * CONFIG.myScoreBoost, 10);
                _lastSpoofedScore = modified.score;
                log(`📤 [RANKED_SCORE type] score: ${json.score}→${modified.score}`);
                spoofPanel();
                return originalSend.call(this, rewriteBytes(bytes, json, modified));
            }
        }
        return originalSend.call(this, data);
    };

    // ── INCOMING DataChannel — pure passthrough, no modification ─────────────
    // Just log opponent scores, don't touch the bytes (avoids corruption/0.0 display)
    const origOnMessageDesc = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
    if (origOnMessageDesc) {
        Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
            set(fn) {
                origOnMessageDesc.set.call(this, function(event) {
                    const parsed = tryDecode(event.data);
                    if (parsed?.json) {
                        const { json } = parsed;
                        if (typeof json.p !== 'undefined' && typeof json.q !== 'undefined' && !json.type && json.q > 0) {
                            log(`📥 OPP frame=${json.p} score=${(json.q/10000).toFixed(2)}`);
                        }
                    }
                    return fn.call(this, event); // pass original event unchanged
                });
            },
            get: origOnMessageDesc.get,
            configurable: true
        });
    }

    const originalAEL = RTCDataChannel.prototype.addEventListener;
    RTCDataChannel.prototype.addEventListener = function (type, listener, options) {
        if (type !== 'message' || typeof listener !== 'function')
            return originalAEL.call(this, type, listener, options);

        const wrapped = function (event) {
            const parsed = tryDecode(event.data);
            if (parsed?.json) {
                const { json } = parsed;
                if (typeof json.p !== 'undefined' && typeof json.q !== 'undefined' && !json.type && json.q > 0) {
                    log(`📥 OPP (AEL) frame=${json.p} score=${(json.q/10000).toFixed(2)}`);
                }
            }
            return listener.call(this, event); // pass original event unchanged
        };
        return originalAEL.call(this, type, wrapped, options);
    };

    // ── Fetch intercept — finalize + Supabase profile ────────────────────────
    const origFetch = window.fetch;
    window.fetch = async function(url, options) {
        const urlStr = typeof url === 'string' ? url : (url?.url || '');

        // LOG EVERY REQUEST
        console.log('🔍 FETCH:', urlStr);

        // Handle finalize endpoints
        if (urlStr.includes('/api/match/finalize') || urlStr.includes('/api/ranked/finalize')) {
            if (options?.body) {
                try {
                    const body = JSON.parse(options.body);
                    log('📤 FINALIZE (original):', JSON.stringify(body).substring(0, 500));

                    const scoreObj = body.u || body.i;
                    if (scoreObj && scoreObj.e !== undefined) {
                        const realE = parseInt(scoreObj.e) || 0;
                        const realO = parseInt(scoreObj.o) || 0;

                        const _finalTarget = _getFinalTarget();
                        scoreObj.e = String(_finalTarget);

                        if (scoreObj.o !== undefined) {
                            scoreObj.o = String(Math.min(
                                Math.max(realO, 1000),
                                parseInt(CONFIG.oppFinalScore)
                            ));
                        }

                        if (body.i) _isRanked = true;
                        const whichMode = _isRanked ? 'RANKED body.i' : 'NORMAL body.u';
                        log(`🎯 [${whichMode}] score.e: ${realE} → ${scoreObj.e} | score.o: ${realO} → ${scoreObj.o}`);
                    }

                    options = { ...options, body: JSON.stringify(body) };
                    log('📤 FINALIZE REQUEST (modified):', JSON.stringify(body));
                } catch(e) {
                    log('⚠️ Could not parse finalize body:', e);
                }
            }

            const response = await origFetch.call(this, url, options);
            const clone = response.clone();
            clone.json().then(data => {
                log('📥 FINALIZE RESPONSE:', JSON.stringify(data));
                // Only reset lock after a successful finalize (not 409 retry)
                if (response.ok) {
                    _lockedFinalTarget = null;
                    _finalApplied = false;
                    _lastSpoofedScore = null;  // ← add this
                }
            }).catch(() => {});
            return response;
        }

        // ═══ PROFILE INTERCEPT (ALL ENDPOINTS) ═══════════════════════════════════
        const BOOSTED_STATS = {
            elo_rating: 95500,
            total_wins: 45000,
            is_dev: true,
            is_pro: true,
            current_win_streak: 5000,
            current_loss_streak: 0,
            public_appeal_sum: 95000,
            public_appeal_count: 100
        };

        // 1. Supabase direct endpoint (returns array)
        if (urlStr.includes('supabase.co/rest/v1/profiles')) {
            const response = await origFetch.call(this, url, options);
            const clone = response.clone();
            try {
                const data = await clone.json();
                log('📊 SUPABASE PROFILE (original):', JSON.stringify(data));

                if (Array.isArray(data) && data.length > 0) {
                    const modified = data.map(profile => ({
                        ...profile,
                        ...BOOSTED_STATS
                    }));
                    log('📊 SUPABASE PROFILE (modified):', JSON.stringify(modified));

                    // Clone headers and ensure content-type is set
                    const newHeaders = new Headers(response.headers);
                    newHeaders.set('content-type', 'application/json');

                    return new Response(JSON.stringify(modified), {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders
                    });
                }
            } catch(e) {
                log('⚠️ Supabase intercept error:', e);
            }
            return response;
        }

        // 2. Omoggle public profile endpoint
        if (urlStr.includes('/api/profiles/public/')) {
            const response = await origFetch.call(this, url, options);
            const clone = response.clone();
            try {
                const data = await clone.json();
                console.log('📊 PUBLIC PROFILE ORIGINAL:', urlStr, JSON.stringify(data, null, 2));

                if (data && data.profile) {
                    const modified = {
                        ...data,
                        profile: {
                            ...data.profile,
                            elo_rating: 95500,
                            total_wins: 45000,
                            is_pro: true,
                            current_win_streak: 5000,
                            current_loss_streak: 0,
                            public_appeal_sum: 95000,
                            public_appeal_count: 100,
                            rank_tier: {
                                name: "GOD",
                                emoji: "👑",
                                hexColor: "#FFD700",
                                textShadow: "0 0 20px rgba(255,215,0,1)"
                            }
                        }
                    };
                    console.log('📊 PUBLIC PROFILE MODIFIED:', JSON.stringify(modified, null, 2));
                    return new Response(JSON.stringify(modified), {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers
                    });
                }
            } catch(e) {
                console.error('⚠️ PUBLIC PROFILE error:', e);
            }
            return response;
        }

        // 3. /api/profile/ranked-stats
        if (urlStr.includes('/api/profile/ranked-stats')) {
            const response = await origFetch.call(this, url, options);
            const clone = response.clone();
            try {
                const data = await clone.json();
                console.log('📊 RANKED-STATS ORIGINAL:', JSON.stringify(data, null, 2));

                const modified = {
                    ...data,
                    rating: 95500,           // Modify existing field
                    currentElo: 95500,       // Modify existing field
                    wins: 45000,             // Modify existing field
                    losses: 0,               // Modify existing field
                    matchesPlayed: 45000     // Update to match wins
                };
                console.log('📊 RANKED-STATS MODIFIED:', JSON.stringify(modified, null, 2));
                return new Response(JSON.stringify(modified), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
            } catch(e) {
                console.error('⚠️ RANKED-STATS error:', e);
            }
            return response;
        }

        // 4. /api/profile/world-rank
        if (urlStr.includes('/api/profile/world-rank')) {
            const response = await origFetch.call(this, url, options);
            const clone = response.clone();
            try {
                const data = await clone.json();
                console.log('📊 WORLD-RANK ORIGINAL:', JSON.stringify(data, null, 2));

                const modified = {
                    ...data,
                    rank: 1,             // You're #1 in the world
                    elo: 95500,          // Modify existing elo field
                    percentile: 99.9
                };
                console.log('📊 WORLD-RANK MODIFIED:', JSON.stringify(modified, null, 2));
                return new Response(JSON.stringify(modified), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
            } catch(e) {
                console.error('⚠️ WORLD-RANK error:', e);
            }
            return response;
        }

        // Add after the world-rank block, before the final return statement

        // 5. /api/profile/lobby-summary
        if (urlStr.includes('/api/profile/lobby-summary')) {
            const response = await origFetch.call(this, url, options);
            const clone = response.clone();
            try {
                const data = await clone.json();
                console.log('📊 LOBBY-SUMMARY ORIGINAL:', JSON.stringify(data, null, 2));

                if (data && typeof data === 'object') {
                    const modified = {
                        ...data,
                        elo_rating: 95500,
                        total_wins: 45000,
                        current_win_streak: 5000,
                        current_loss_streak: 0,
                        rank_tier: {
                            name: "GOD",
                            emoji: "👑",
                            hexColor: "#FFD700",
                            textShadow: "0 0 20px rgba(255,215,0,1)"
                        }
                    };
                    console.log('📊 LOBBY-SUMMARY MODIFIED:', JSON.stringify(modified, null, 2));
                    return new Response(JSON.stringify(modified), {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers
                    });
                }
            } catch(e) {
                console.error('⚠️ LOBBY-SUMMARY error:', e);
            }
            return response;
        }

        // 6. /api/profile (catch-all for remaining profile endpoints)
        if (urlStr === '/api/profile' || urlStr.endsWith('/api/profile')) {
            const response = await origFetch.call(this, url, options);
            const clone = response.clone();
            try {
                const data = await clone.json();
                console.log('📊 /api/profile ORIGINAL:', JSON.stringify(data, null, 2));

                if (data && data.profile) {
                    const modified = {
                        ...data,
                        profile: {
                            ...data.profile,
                            elo_rating: 95500,
                            total_wins: 45000,
                            rank_tier: {
                                name: "GOD",
                                emoji: "👑",
                                hexColor: "#FFD700",
                                textShadow: "0 0 20px rgba(255,215,0,1)"
                            }
                        }
                    };
                    console.log('📊 /api/profile MODIFIED:', JSON.stringify(modified, null, 2));
                    return new Response(JSON.stringify(modified), {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers
                    });
                }
            } catch(e) {
                console.error('⚠️ /api/profile error:', e);
            }
            return response;
        }

        return origFetch.call(this, url, options);
    };

    let _lockedFinalTarget = null;
    let _lastFinalMode = null;
    let _finalApplied = false;

    function _getFinalTarget() {
        // Re-lock if mode changed or no lock yet
        if (_lockedFinalTarget === null || _lastFinalMode !== CONFIG.finalScoreMode) {
            _finalApplied = false;
            _lastFinalMode = CONFIG.finalScoreMode;
            if (CONFIG.finalScoreMode === 'range') {
                _lockedFinalTarget = Math.round(CONFIG.finalScoreRangeMin + Math.random() * (CONFIG.finalScoreRangeMax - CONFIG.finalScoreRangeMin));
            } else {
                _lockedFinalTarget = parseInt(CONFIG.myFinalScore);
            }
            log(`🎯 _getFinalTarget locked: ${_lockedFinalTarget} (${CONFIG.finalScoreMode})`);
        }
        // In fixed mode always return current slider value (no lock needed)
        if (CONFIG.finalScoreMode === 'fixed') {
            return parseInt(CONFIG.myFinalScore);
        }
        return _lockedFinalTarget;
    }

    // ── Zustand store patch ───────────────────────────────────────────────────
    function patchZustandStore() {
        try {
            const wpChunk = window.webpackChunk_N_E || window.webpackChunknextjs_app || window.webpackChunk;
            if (!wpChunk) return false;
            const req = wpChunk.push([[Symbol()], {}, e => e]);
            const mod = req(16225);
            if (!mod) return false;
            const store = Object.values(mod).find(val =>
                                                  val && typeof val.getState === 'function' && 'myScore' in (val.getState() || {})
                                                 );
            if (!store) return false;
            return patchStore(store);
        } catch(e) {
            log('⚠️ patchZustandStore error:', e);
            return false;
        }
    }

    function patchStore(store) {
        try {
            const state = store.getState();

            // patch setMyScore
            // patch setMyScore — only override at end of match (high score = final result)
            const origSetMyScore = state.setMyScore;
            if (origSetMyScore && !origSetMyScore.__patched) {
                store.setState({
                    setMyScore: function(score) {
                        const cap = CONFIG.frameCap / 10000;
                        let boosted;
                        if (CONFIG.boostMode === 'range') {
                            const rangeMult = CONFIG.boostRangeMin + Math.random() * (CONFIG.boostRangeMax - CONFIG.boostRangeMin);
                            boosted = Math.min(score * rangeMult, cap);
                        } else {
                            boosted = Math.min(score * CONFIG.myScoreBoost * _boostMultiplier, cap);
                        }
                        log(`🎯 setMyScore: ${score.toFixed(2)} → ${boosted.toFixed(2)}`);
                        _lastSpoofedScore = boosted;
                        spoofPanel();
                        return origSetMyScore.call(this, boosted);
                    }
                });
                store.getState().setMyScore.__patched = true;
                log('✅ setMyScore patched');
            }

            // patch applyFinalScores
            const origApply = state.applyFinalScores;
            if (origApply && !origApply.__patched) {
                store.setState({
                    applyFinalScores: function(p1, p2, iAmPlayer1) {
                        log('🏁 applyFinalScores called — injecting final target');
                        const target = _getFinalTarget();
                        const myScore = target / 10000;
                        const oppScore = Math.max(parseInt(CONFIG.oppFinalScore), 1000) / 10000;
                        const newP1 = iAmPlayer1 ? myScore : oppScore;
                        const newP2 = iAmPlayer1 ? oppScore : myScore;
                        log(`🚀 applyFinalScores → p1=${newP1} p2=${newP2} iAmPlayer1=${iAmPlayer1}`);
                        _finalApplied = true;
                        _lastSpoofedScore = null;
                        // Do NOT set _lastSpoofedScore or call spoofPanel here —
                        // the results screen will render from Zustand naturally,
                        // and live panel keeps showing the real boosted frame score
                        return origApply.call(this, newP1, newP2, iAmPlayer1);
                    }
                });
                store.getState().applyFinalScores.__patched = true;
                log('✅ applyFinalScores patched');
                // Hold the final score in Zustand until the match screen clears
            }

            return true;
        } catch(e) {
            log('⚠️ patchStore error:', e);
            return false;
        }
    }

    let patchAttempts = 0;
    const patchPoll = setInterval(() => {
        patchAttempts++;
        if (patchZustandStore()) {
            clearInterval(patchPoll);
        } else if (patchAttempts % 50 === 0) {
            log(`⏳ Still looking for Zustand store... (attempt ${patchAttempts})`);
        }
    }, 200);

    // ── UI Panel spoof ────────────────────────────────────────────────────────
    const TIER_MAP = [
        { name: 'Adam',     emoji: '🍎', hexColor: '#ef4444', textShadow: '0 0 12px rgba(239,68,68,0.95)',    min: 9.7 },
        { name: 'Slayer',   emoji: '☠️', hexColor: '#f472b6', textShadow: '0 0 12px rgba(244,114,182,0.9)',   min: 9.5 },
        { name: 'Chad',     emoji: '👑', hexColor: '#fb923c', textShadow: '0 0 10px rgba(251,146,60,0.8)',    min: 8.9 },
        { name: 'Chadlite', emoji: '⚜️', hexColor: '#facc15', textShadow: '0 0 8px rgba(250,204,21,0.8)',     min: 8.3 },
        { name: 'HTN',      emoji: '🌟', hexColor: '#a3e635', textShadow: '0 0 8px rgba(163,230,53,0.8)',     min: 7.0 },
        { name: 'MTN',      emoji: '⭐', hexColor: '#86efac', textShadow: '0 0 6px rgba(134,239,172,0.7)',    min: 5.6 },
        { name: 'LTN',      emoji: '🌙', hexColor: '#34d399', textShadow: '0 0 6px rgba(52,211,153,0.6)',     min: 3.1 },
        { name: 'Sub3',     emoji: '🦀', hexColor: '#b45309', textShadow: '0 0 6px rgba(180,83,9,0.7)',       min: 0.1 },
    ];

    let _lastSpoofedScore = null;
    let _boostMultiplier = 1.0;      // live multiplier applied on top of myScoreBoost
    let _boostHeld = false;
    let _boostRampAF = null;         // requestAnimationFrame handle

    function rampBoost(toHeld) {
        if (_boostRampAF) { cancelAnimationFrame(_boostRampAF); _boostRampAF = null; }
        const start = _boostMultiplier;
        const targetMultiplier = toHeld
        ? 1 + (CONFIG.boostPercent / 100) * (1 + (Math.random() * 2 - 1) * CONFIG.boostRandom / 100)
        : 1.0;
        const startTime = performance.now();
        function step(now) {
            const t = Math.min(1, (now - startTime) / CONFIG.boostDuration);
            // ease in-out cubic
            const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;
            _boostMultiplier = start + (targetMultiplier - start) * ease;
            if (t < 1) {
                _boostRampAF = requestAnimationFrame(step);
            } else {
                _boostMultiplier = targetMultiplier;
                _boostRampAF = null;
            }
        }
        _boostRampAF = requestAnimationFrame(step);
    }

    function getTierForScore(score) {
        for (const tier of TIER_MAP) {
            if (score >= tier.min) return tier;
        }
        return TIER_MAP[TIER_MAP.length - 1];
    }

    function spoofPanel() {
        if (_lastSpoofedScore === null) return;
        const displayScore = _lastSpoofedScore;
        const tier = getTierForScore(displayScore);

        // Try normal panel selectors first, then ranked-specific ones
        const myPanel = document.querySelector('.glass-panel.absolute.top-5') ||
              document.querySelector('.glass-panel.absolute.top-8') ||
              document.querySelector('[class*="glass-panel"][class*="absolute"][class*="left"]') ||
              document.querySelector('[class*="glass-panel"][class*="absolute"][class*="top"]') ||
              // Ranked mode uses a different panel structure
              document.querySelector('[class*="ranked"][class*="score"]') ||
              document.querySelector('[class*="player-score"]') ||
              document.querySelector('[class*="my-score"]') ||
              // Fallback: find any panel containing a font-mono score span
              (() => {
                  const allPanels = document.querySelectorAll('[class*="glass"], [class*="panel"], [class*="score-card"]');
                  for (const p of allPanels) {
                      const spans = p.querySelectorAll('span.font-mono');
                      for (const s of spans) {
                          if (/^\d+\.?\d*$/.test(s.textContent.trim())) return p;
                      }
                  }
                  return null;
              })();
        if (!myPanel) return;

        const allMono = myPanel.querySelectorAll('span.font-mono');
        let scoreSpan = null;
        for (const s of allMono) {
            if (/^\d+\.?\d*$/.test(s.textContent.trim())) {
                scoreSpan = s;
                break;
            }
        }
        if (!scoreSpan) return;

        // Fix score text only — do NOT touch its color or textShadow
        if (scoreSpan.textContent.trim() !== displayScore.toFixed(1)) {
            scoreSpan.textContent = displayScore.toFixed(1);
        }

        // Fix tier label span (next sibling after score)
        const tierSpan = scoreSpan.nextElementSibling;
        if (tierSpan) {
            const want = `${tier.emoji} ${tier.name}`;
            if (tierSpan.textContent !== want) {
                tierSpan.textContent = want;
            }
            if (tierSpan.style.color !== tier.hexColor) {
                tierSpan.style.color = tier.hexColor;
            }
            if (tierSpan.style.textShadow !== tier.textShadow) {
                tierSpan.style.textShadow = tier.textShadow;
            }
        }

        // Scan ALL spans — only recolor tier name spans, not the score span
        const allSpans = myPanel.querySelectorAll('span');
        for (const span of allSpans) {
            if (span === scoreSpan) continue; // skip the score number span entirely
            const t = span.textContent.trim();
            const tierNames = ['Adam','Slayer','Chad','Chadlite','HTN','MTN','LTN','Sub3'];
            if (tierNames.some(n => t.includes(n)) && !t.includes(tier.name)) {
                span.textContent = `${tier.emoji} ${tier.name}`;
                span.style.color = tier.hexColor;
                span.style.textShadow = tier.textShadow;
            }
            // Only recolor tier-colored spans that are NOT the score span
            if (span.style.color && span.style.color !== tier.hexColor) {
                const tierColors = ['#ef4444','#f472b6','#fb923c','#facc15','#a3e635','#86efac','#34d399','#b45309'];
                if (tierColors.includes(span.style.color)) {
                    span.style.color = tier.hexColor;
                    span.style.textShadow = tier.textShadow;
                }
            }
        }
    }

    // MutationObserver fires the moment React updates the DOM — no visible flash
    const _panelObserver = new MutationObserver(spoofPanel);
    let _observedPanel = null;

    function attachPanelObserver() {
        const myPanel = document.querySelector('.glass-panel.absolute.top-5') ||
              document.querySelector('.glass-panel.absolute.top-8') ||
              document.querySelector('[class*="glass-panel"][class*="absolute"][class*="left"]') ||
              document.querySelector('[class*="glass-panel"][class*="absolute"][class*="top"]') ||
              document.querySelector('[class*="ranked"][class*="score"]') ||
              document.querySelector('[class*="player-score"]') ||
              document.querySelector('[class*="my-score"]') ||
              (() => {
                  const allPanels = document.querySelectorAll('[class*="glass"], [class*="panel"], [class*="score-card"]');
                  for (const p of allPanels) {
                      const spans = p.querySelectorAll('span.font-mono');
                      for (const s of spans) {
                          if (/^\d+\.?\d*$/.test(s.textContent.trim())) return p;
                      }
                  }
                  return null;
              })();
        if (myPanel && myPanel !== _observedPanel) {
            if (_observedPanel) _panelObserver.disconnect();
            _panelObserver.observe(myPanel, { childList: true, subtree: true, characterData: true });
            _observedPanel = myPanel;
        }
    }

    setInterval(() => { attachPanelObserver(); spoofPanel(); }, 16);

    // ── WebSocket monitor ─────────────────────────────────────────────────────
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function(...args) {
        const ws = new OriginalWebSocket(...args);
        ws.addEventListener('message', function(event) {
            if (typeof event.data === 'string') {
                if (event.data.includes('FINAL_SCORES') || event.data.includes('elo') || event.data.includes('score')) {
                    log('📡 WS TEXT:', event.data);
                }
                return;
            }
            const buf = event.data instanceof ArrayBuffer ? event.data : null;
            if (!buf) return;
            const bytes = new Uint8Array(buf);
            const size = bytes.length;
            const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            const strings = text.match(/[\x20-\x7E]{4,}/g) || [];
            if (size === 108 || size > 50) {
                log(`📡 WS RECV binary [${size} bytes] strings:`, strings);
                strings.forEach(s => {
                    if (/\d\.\d/.test(s) || s.includes('score') || s.includes('win') || s.includes('elo')) {
                        log('   ⚠️  Possible score string:', s);
                    }
                });
            }
        });
        return ws;
    };
    Object.setPrototypeOf(window.WebSocket, OriginalWebSocket);
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k => {
        try {
            Object.defineProperty(window.WebSocket, k, {
                value: OriginalWebSocket[k],
                writable: false,
                configurable: true
            });
        } catch(e) {}
    });

    log('🚀 v12 — clean passthrough incoming | u.e/i.e finalize boost | outgoing q boost');

    // ── CAMERA PIPELINE DEBUG ─────────────────────────────────────────────────

    // 1. Intercept getUserMedia — see what constraints the game requests
    const _dbgGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function(constraints) {
        console.log('🎥 getUserMedia called:', JSON.stringify(constraints));
        const stream = await _dbgGetUserMedia(constraints);
        console.log('🎥 getUserMedia returned stream:', stream.id,
                    '| video tracks:', stream.getVideoTracks().map(t => `${t.label} [${t.readyState}]`),
                    '| audio tracks:', stream.getAudioTracks().map(t => `${t.label} [${t.readyState}]`)
                   );
        // Log every time a track ends
        stream.getVideoTracks().forEach(t => {
            t.addEventListener('ended', () => console.log('🎥 VIDEO TRACK ENDED:', t.label));
            t.addEventListener('mute',  () => console.log('🎥 VIDEO TRACK MUTED:', t.label));
        });
        return stream;
    };

    // 2. Intercept RTCPeerConnection — see how video is added to the peer connection
    const _OrigRTCPC = window.RTCPeerConnection;
    window.RTCPeerConnection = function(...args) {
        const pc = new _OrigRTCPC(...args);
        console.log('📡 RTCPeerConnection created', args[0]?.iceServers?.length ? `(${args[0].iceServers.length} ice servers)` : '');

        const _origAddTrack = pc.addTrack.bind(pc);
        pc.addTrack = function(track, ...streams) {
            console.log(`📡 addTrack: kind=${track.kind} label="${track.label}" id=${track.id} readyState=${track.readyState}`);
            if (track.kind === 'video') {
                console.log('📡 VIDEO TRACK ADDED TO PEER CONNECTION — this is what opponent receives');
            }
            return _origAddTrack(track, ...streams);
        };

        const _origAddStream = pc.addStream?.bind(pc);
        if (_origAddStream) {
            pc.addStream = function(stream) {
                console.log('📡 addStream:', stream.id,
                            stream.getVideoTracks().map(t => t.label));
                return _origAddStream(stream);
            };
        }

        const _origSetLD = pc.setLocalDescription.bind(pc);
        pc.setLocalDescription = function(desc) {
            if (desc?.sdp) {
                const videoLines = desc.sdp.split('\n').filter(l =>
                                                               l.startsWith('m=video') || l.startsWith('a=rtpmap') || l.startsWith('a=msid')
                                                              );
                console.log('📡 setLocalDescription (video lines):', videoLines);
            }
            return _origSetLD(desc);
        };

        pc.addEventListener('track', e => {
            console.log(`📡 REMOTE TRACK received: kind=${e.track.kind} label="${e.track.label}"`,
                        '— this is what YOU receive from opponent');
        });

        pc.addEventListener('connectionstatechange', () => {
            console.log('📡 PC connectionState:', pc.connectionState);
        });

        return pc;
    };
    Object.setPrototypeOf(window.RTCPeerConnection, _OrigRTCPC);
    window.RTCPeerConnection.prototype = _OrigRTCPC.prototype;

    // 3. Watch the scanner-video element — see when/how the game assigns a stream to it
    function watchScannerVideo() {
        const scannerVideo = document.querySelector('video.scanner-video');
        if (scannerVideo) {
            console.log('🔍 scanner-video found, watching srcObject...');
            // Watch for srcObject being set
            const _origSrcObj = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
            Object.defineProperty(scannerVideo, 'srcObject', {
                get() { return _origSrcObj.get.call(this); },
                set(stream) {
                    if (stream) {
                        console.log('🔍 scanner-video.srcObject SET:', stream?.id,
                                    '| video:', stream?.getVideoTracks?.().map(t => `${t.label} [${t.readyState}]`),
                                    '| audio:', stream?.getAudioTracks?.().map(t => t.label)
                                   );
                        console.log('🔍 This stream feeds the face scanner — replacing this = camera spoof');
                    }
                    _origSrcObj.set.call(this, stream);
                },
                configurable: true
            });
        } else {
            // Not in DOM yet — observe
            const obs = new MutationObserver(() => {
                const v = document.querySelector('video.scanner-video');
                if (v) { obs.disconnect(); watchScannerVideo(); }
            });
            obs.observe(document.body, { childList: true, subtree: true });
        }
    }
    watchScannerVideo();

    // 4. Intercept HTMLVideoElement.srcObject globally — catch ALL video element stream assignments
    const _origSrcObjDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        get() { return _origSrcObjDesc.get.call(this); },
        set(stream) {
            if (this.tagName === 'VIDEO' && stream) {
                const classes = this.className || '(no class)';
                const tracks = stream?.getVideoTracks?.() || [];
                console.log(`🎞 video.srcObject SET [class="${classes}"]`,
                            `stream=${stream?.id}`,
                            `videoTracks:`, tracks.map(t => `${t.label} [${t.readyState}]`)
                           );
                if (classes.includes('scanner')) {
                    console.log('🎞 ↑ THIS IS THE SCANNER VIDEO — intercept here to replace camera feed');
                }
            }
            _origSrcObjDesc.set.call(this, stream);
        },
        configurable: true
    });

    // ── MENU ─────────────────────────────────────────────────────────────────
    function buildMenu() {
        if (document.getElementById('mog-root')) return;

        const style = document.createElement('style');
        const fontFaces = [
            ['Ebisu-Light', 300],
            ['Ebisu', 400],
            ['Ebisu-Bold', 700]
        ].map(([name, weight]) =>
              '@font-face{font-family:"Ebisu";src:url("https://github.com/sevkabevka/sevkabevka.github.io/raw/refs/heads/main/' + name + '.ttf") format("truetype");font-weight:' + weight + ';}'
             ).join('');
        style.textContent = fontFaces + `
            :root {
                --mog-accent: #80FF00;
                --mog-accent-rgb: 128,255,0;
            }
            #mog-btn {
                position: fixed; bottom: 20px; right: 20px; z-index: 999999;
                background: #050716; border: 2px solid #434464;
                color: var(--mog-accent); font-size: 11px; font-weight: 900; font-family: monospace;
                padding: 7px 13px; border-radius: 10px; cursor: pointer;
                letter-spacing: 0.12em; text-transform: uppercase;
                box-shadow: 0 0 18px rgba(67,68,100,0.4);
                backdrop-filter: blur(10px); transition: all 0.2s; user-select: none;
            }
            #mog-btn:hover { background: rgba(67,68,100,0.25); }
          #mog-root {
                position: fixed; bottom: auto; right: auto; top: 50%; left: 50%;
                transform: translate(-50%, -50%);
                z-index: 999999;
                width: 300px;
                background: #444782;
                border-radius: 16px;
                font-family: 'Ebisu', monospace; font-size: 11px; color: #e2d9f3;
                backdrop-filter: blur(20px); display: none; overflow: hidden;
                border: 2px solid #434464;
                box-shadow:
                    0 0 40px rgba(0,0,0,0.9),
                    0 12px 40px rgba(0,0,0,0.8);
            }
            #mog-root::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                width: 220px;
                height: 220px;
                border-radius: 0 0 100% 0;
                background: radial-gradient(circle at top left, rgba(37,38,63,1) 0%, rgba(37,38,63,0.5) 35%, transparent 70%);
                pointer-events: none;
                z-index: 0;
                overflow: hidden;
            }
            #mog-root::after {
                content: '';
                position: absolute;
                inset: 0;
                border-radius: 14px;
                background: #0d0f1e;
                z-index: -1;
                pointer-events: none;
            }
            #mog-header {
                padding: 12px 16px 0;
                background: transparent;
                border-bottom: none;
                border-radius: 14px 14px 0 0;
                position: relative; z-index: 1;
            }
            @keyframes mog-pulse {
                0%, 100% { opacity: 1; text-shadow: 0 0 8px var(--mog-accent), 0 0 18px var(--mog-accent), 0 0 32px rgba(var(--mog-accent-rgb),0.5); }
                50%       { opacity: 0.45; text-shadow: 0 0 4px var(--mog-accent), 0 0 8px rgba(var(--mog-accent-rgb),0.3); }
            }
            @keyframes mog-dot-pulse {
                0%, 100% { opacity: 1; box-shadow: 0 0 6px var(--mog-accent), 0 0 14px rgba(var(--mog-accent-rgb),0.6); }
                50%       { opacity: 0.35; box-shadow: 0 0 3px var(--mog-accent); }
            }
            #mog-title {
                font-size: 12px; font-weight: 900; letter-spacing: 0.2em;
                text-transform: uppercase;
                margin-bottom: 10px;
                display: flex; align-items: center; gap: 7px;
                color: #ffffff;
                text-shadow: 0 0 6px rgba(255,255,255,0.15);
            }
            #mog-title .mog-lock {
                color: var(--mog-accent);
                animation: mog-pulse 2s ease-in-out infinite;
                display: inline;
                margin-left: -0.6em;
            }
            #mog-title::before {
                content: '';
                display: inline-block;
                width: 8px; height: 8px;
                border-radius: 50%;
                background: var(--mog-accent);
                animation: mog-dot-pulse 2s ease-in-out infinite;
                flex-shrink: 0;
            }
            #mog-tabs-bar {
    background: #101426;
    border: 1px solid #434464;
    border-radius: 20px;
    display: flex;
    gap: 0px;
    padding: 5px 5px;
    margin-bottom: 12px;
    width: calc(100% + 16px);
    margin-left: -11px;
}
            #mog-tabs {
                display: contents;
            }
            .mog-tab {
                padding: 4px 10px; border-radius: 16px; font-size: 9px;
                font-weight: 900; text-transform: uppercase; letter-spacing: 0.15em;
                cursor: pointer; color: #878AA2;
                border: 1px solid transparent;
                transition: all 0.15s; background: transparent;
                flex: 1; text-align: center;
            }
            .mog-tab.active {
                color: #ffffff; background: #1D1E37;
                border-color: #433F74;
                border-radius: 16px;
            }
            .mog-tab:hover:not(.active) { color: rgba(255,255,255,0.7); }
            #mog-body {
                padding: 14px 16px 16px;
                display: grid;
                grid-template-rows: 1fr;
                position: relative; z-index: 1;
            }
            .mog-panel {
                display: none;
                opacity: 0;
                transform: translateY(6px);
            }
            .mog-panel.active {
                display: block;
            }
            #mog-root {
                transition: height 0.25s cubic-bezier(0.4,0,0.2,1),
                            opacity 0.2s ease,
                            transform 0.2s cubic-bezier(0.34,1.56,0.64,1);
            }
            .mog-label {
                font-size: 9px; font-weight: 900; text-transform: uppercase;
                letter-spacing: 0.18em; color: rgba(255,255,255,0.4); margin-bottom: 5px;
            }
            .mog-row {
                display: flex; align-items: center; justify-content: space-between;
                margin-bottom: 10px; gap: 8px;
            }
            .mog-row span {
                font-size: 10px; color: #c4b5fd; min-width: 40px; text-align: right;
            }
            .mog-slider {
                -webkit-appearance: none; flex: 1; height: 3px; border-radius: 2px;
                background: rgba(255,255,255,0.15); outline: none; cursor: pointer;
            }
            .mog-slider::-webkit-slider-thumb {
                -webkit-appearance: none; width: 12px; height: 12px;
                border-radius: 50%; background: #a78bfa; cursor: pointer;
                box-shadow: 0 0 6px rgba(167,139,250,0.8);
            }
            .mog-sep {
                border: none; border-top: 1px solid #434464;
                margin: 10px 0;
            }w
            .mog-status-row {
                display: flex; align-items: center; justify-content: space-between;
                margin-bottom: 6px;
            }
            .mog-badge {
                font-size: 9px; font-weight: 900; text-transform: uppercase;
                letter-spacing: 0.15em; padding: 3px 8px; border-radius: 6px;
            }
            .mog-badge.ranked { background: rgba(168,85,247,0.2); color: #d8b4fe; border: 1px solid rgba(168,85,247,0.4); }
            .mog-badge.normal { background: rgba(59,130,246,0.2); color: #93c5fd; border: 1px solid rgba(59,130,246,0.3); }
            .mog-badge.on { background: rgba(34,197,94,0.2); color: #86efac; border: 1px solid rgba(34,197,94,0.4); }
            .mog-badge.off { background: rgba(239,68,68,0.2); color: #fca5a5; border: 1px solid rgba(239,68,68,0.4); }
            .mog-score-preview {
                background: #12162B; border: 1px solid #434464;
                border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
            }
            .mog-score-big {
                font-size: 22px; font-weight: 900; letter-spacing: 0.05em;
            }
            .mog-score-tier {
                font-size: 9px; font-weight: 900; text-transform: uppercase;
                letter-spacing: 0.2em; margin-top: 2px;
            }
            .mog-toggle-row {
                display: flex; align-items: center; justify-content: space-between;
                margin-bottom: 8px;
            }
            .mog-toggle-label { font-size: 10px; color: #c4b5fd; }
            .mog-switch {
                position: relative; width: 32px; height: 18px; cursor: pointer;
            }
            .mog-switch input { opacity: 0; width: 0; height: 0; }
            .mog-switch-track {
                position: absolute; inset: 0; border-radius: 9px;
                background: rgba(255,255,255,0.12);
                transition: background 0.25s cubic-bezier(0.4,0,0.2,1),
                            box-shadow 0.25s ease;
            }
.mog-switch input:checked + .mog-switch-track {
                background: var(--mog-accent);
                box-shadow: 0 0 10px rgba(var(--mog-accent-rgb),0.6);
            }
            .mog-switch-thumb {
                position: absolute; top: 3px; left: 3px; width: 12px; height: 12px;
                border-radius: 50%; background: white;
                box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                transition: left 0.25s cubic-bezier(0.34,1.56,0.64,1),
                            transform 0.2s ease;
            }
            .mog-switch input:checked ~ .mog-switch-thumb {
                left: 17px;
                transform: scale(1.1);
            }
            .mog-switch:hover .mog-switch-thumb { transform: scale(1.15); }
            .mog-switch input:checked:hover ~ .mog-switch-thumb { transform: scale(1.25); }
            .mog-feature-box {
                background: #12162B; border: 1px solid #434464;
                border-radius: 10px; margin-bottom: 12px; overflow: hidden;
            }
            .mog-feature-box-title {
                font-size: 9px; font-weight: 900; text-transform: uppercase;
                letter-spacing: 0.18em; color: #7C81A5; margin-bottom: 6px;
            }
            .mog-feature-row {
                display: flex; align-items: center; justify-content: space-between;
                padding: 8px 12px;
            }
            .mog-feature-row .mog-slider {
                max-width: 110px;
            }
            .mog-feature-box > .mog-feature-row:not(:last-child) {
                border-bottom: 1px solid #434464;
            }
            [data-panel="score"] .mog-slider::-webkit-slider-thumb {
                background: var(--mog-accent);
                box-shadow: 0 0 8px var(--mog-accent), 0 0 18px rgba(var(--mog-accent-rgb),0.5);
            }
            [data-panel="score"] .mog-feature-row div[style*="background:#181b30"] {
                border-color: #434464 !important;
            }
            [data-panel="fun"] .mog-slider::-webkit-slider-thumb {
                background: var(--mog-accent);
                box-shadow: 0 0 8px var(--mog-accent), 0 0 18px rgba(var(--mog-accent-rgb),0.5);
            }
            [data-panel="fun"] .mog-feature-row span.val {
                color: var(--mog-accent) !important;
                text-shadow: 0 0 8px var(--mog-accent), 0 0 18px rgba(var(--mog-accent-rgb),0.5);
            }
            [data-panel="misc"] .mog-slider::-webkit-slider-thumb {
                background: var(--mog-accent);
                box-shadow: 0 0 8px var(--mog-accent), 0 0 18px rgba(var(--mog-accent-rgb),0.5);
            }

            /* ── Panel alignment */
            .mog-panel {
                width: 100%;
                box-sizing: border-box;
            }
            .mog-feature-box {
                width: 100%;
                box-sizing: border-box;
            }
            .mog-feature-box-title {
                width: 100%;
                box-sizing: border-box;
            }

            /* ── Scrollable panels */
            [data-panel="fun"],
            [data-panel="misc"],
            [data-panel="score"] {
                max-height: 420px;
                overflow-y: auto;
                overflow-x: hidden;
                padding-right: 2px;
            }
            [data-panel="fun"]::-webkit-scrollbar,
            [data-panel="misc"]::-webkit-scrollbar,
            [data-panel="score"]::-webkit-scrollbar {
                width: 3px;
            }
            [data-panel="fun"]::-webkit-scrollbar-track,
            [data-panel="misc"]::-webkit-scrollbar-track,
            [data-panel="score"]::-webkit-scrollbar-track {
                background: transparent;
            }
            [data-panel="fun"]::-webkit-scrollbar-thumb,
            [data-panel="misc"]::-webkit-scrollbar-thumb,
            [data-panel="score"]::-webkit-scrollbar-thumb {
                background: rgba(var(--mog-accent-rgb),0.35);
                border-radius: 2px;
            }
            [data-panel="fun"]::-webkit-scrollbar-thumb:hover,
            [data-panel="misc"]::-webkit-scrollbar-thumb:hover,
            [data-panel="score"]::-webkit-scrollbar-thumb:hover {
                background: rgba(var(--mog-accent-rgb),0.65);
            }
        `;
        document.head.appendChild(style);

        // Toggle button
        const btn = document.createElement('button');
        btn.id = 'mog-btn';
        btn.textContent = 'hitlock';
        document.body.appendChild(btn);

        // Menu root
        const root = document.createElement('div');
        root.id = 'mog-root';
        root.innerHTML = `
            <div id="mog-header">
                <div id="mog-title">HIT<span class="mog-lock">LOCK</span></div>
                <div id="mog-tabs-bar">
                    <div id="mog-tabs" style="display:flex;gap:2px;width:100%;">
                        <div class="mog-tab active" data-tab="status">Status</div>
                        <div class="mog-tab" data-tab="score">Score</div>
                        <div class="mog-tab" data-tab="fun">Fun</div>
                        <div class="mog-tab" data-tab="misc">Misc</div>
                    </div>
                </div>
            </div>
            <hr style="border:none; border-top: 1px solid #433F74; margin: 0 0 0px 0;">
            <div id="mog-body">

                <!-- STATUS TAB -->
<div class="mog-panel active" data-panel="status">

    <div class="mog-feature-box-title">Live Score</div>
    <div class="mog-feature-box" style="padding:10px 12px;">
        <div class="mog-score-big" id="mog-live-score">—</div>
        <div class="mog-score-tier" id="mog-live-tier">Waiting for match...</div>
    </div>

    <div class="mog-feature-box-title">Status</div>
    <div class="mog-feature-box">
        <div class="mog-feature-row">
            <span class="mog-label" style="margin:0">Mode</span>
            <span id="mog-mode-badge" style="font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:0.15em;color:#93c5fd;">NORMAL</span>
        </div>
        <div class="mog-feature-row">
            <span class="mog-label" style="margin:0">Script</span>
            <span id="mog-enabled-badge" style="font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:0.15em;color:#86efac;">ENABLED</span>
        </div>
        <div class="mog-feature-row">
            <span class="mog-label" style="margin:0">Zustand</span>
            <span id="mog-zustand-badge" style="font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:0.15em;color:#fca5a5;">NOT PATCHED</span>
        </div>
    </div>

    <hr class="mog-sep">
    <div class="mog-toggle-row">
        <span class="mog-toggle-label">Enable script</span>
        <label class="mog-switch">
            <input type="checkbox" id="mog-enable-toggle" checked>
            <div class="mog-switch-track"></div>
            <div class="mog-switch-thumb"></div>
        </label>
    </div>
</div>

                <!-- SCORE TAB -->
                <div class="mog-panel" data-panel="score">
                    <div class="mog-feature-box-title">Live Boost</div>
                    <div class="mog-feature-box">
                        <!-- Mode selector -->
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Mode</span>
                            <div style="display:flex;gap:4px;">
                                <button class="mog-boost-mode-btn active" data-bmode="multiplier" style="padding:3px 8px;border-radius:6px;font-family:monospace;font-size:8px;font-weight:900;text-transform:uppercase;cursor:pointer;transition:all 0.2s;background:rgba(var(--mog-accent-rgb),0.15);color:var(--mog-accent);border:1px solid rgba(var(--mog-accent-rgb),0.4);">Mult</button>
                                <button class="mog-boost-mode-btn" data-bmode="range" style="padding:3px 8px;border-radius:6px;font-family:monospace;font-size:8px;font-weight:900;text-transform:uppercase;cursor:pointer;transition:all 0.2s;background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.1);">Range</button>
                            </div>
                        </div>
                        <!-- Multiplier mode -->
                        <div id="mog-boost-mult-section">
                            <div class="mog-feature-row" style="gap:8px;">
                                <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Boost</span>
                                <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                    <input type="range" class="mog-slider" id="mog-boost-slider" min="1.0" max="3.0" step="0.05" value="1.84" style="width:100%;margin:0;">
                                </div>
                                <span id="mog-boost-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">1.84x</span>
                            </div>
                        </div>
                        <!-- Range mode -->
                        <div id="mog-boost-range-section" style="display:none;">
                            <div class="mog-feature-row" style="gap:8px;">
                                <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Min</span>
                                <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                    <input type="range" class="mog-slider" id="mog-boost-range-min" min="1.0" max="3.0" step="0.05" value="1.0" style="width:100%;margin:0;">
                                </div>
                                <span id="mog-boost-range-min-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">1.0x</span>
                            </div>
                            <div class="mog-feature-row" style="gap:8px;">
                                <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Max</span>
                                <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                    <input type="range" class="mog-slider" id="mog-boost-range-max" min="1.0" max="3.0" step="0.05" value="2.5" style="width:100%;margin:0;">
                                </div>
                                <span id="mog-boost-range-max-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">2.5x</span>
                            </div>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Frame Cap</span>
                            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                <input type="range" class="mog-slider" id="mog-cap-slider" min="10000" max="99000" step="1000" value="99000" style="width:100%;margin:0;">
                            </div>
                            <span id="mog-cap-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">9.9</span>
                        </div>
                    </div>

                    <div class="mog-feature-box-title">Final Score</div>
                    <div class="mog-feature-box">
                        <!-- Mode selector -->
                        <!-- Mode selector -->
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Mode</span>
                            <div style="display:flex;gap:4px;">
                                <button class="mog-final-mode-btn active" data-fmode="fixed" style="padding:3px 7px;border-radius:6px;font-family:monospace;font-size:8px;font-weight:900;text-transform:uppercase;cursor:pointer;transition:all 0.2s;background:rgba(var(--mog-accent-rgb),0.15);color:var(--mog-accent);border:1px solid rgba(var(--mog-accent-rgb),0.4);">Fixed</button>
                                <button class="mog-final-mode-btn" data-fmode="range" style="padding:3px 7px;border-radius:6px;font-family:monospace;font-size:8px;font-weight:900;text-transform:uppercase;cursor:pointer;transition:all 0.2s;background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.1);">Range</button>
                            </div>
                        </div>
                        <!-- Fixed mode -->
                        <div id="mog-final-fixed-section">
                            <div class="mog-feature-row" style="gap:8px;">
                                <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">My Score</span>
                                <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                    <input type="range" class="mog-slider" id="mog-final-score" min="50000" max="99000" step="1000" value="94000" style="width:100%;margin:0;">
                                </div>
                                <span id="mog-final-score-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">9.4</span>
                            </div>
                        </div>
                        <!-- Range mode -->
                        <div id="mog-final-range-section" style="display:none;">
                            <div class="mog-feature-row" style="gap:8px;">
                                <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Min</span>
                                <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                    <input type="range" class="mog-slider" id="mog-final-range-min" min="50000" max="99000" step="1000" value="85000" style="width:100%;margin:0;">
                                </div>
                                <span id="mog-final-range-min-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">8.5</span>
                            </div>
                            <div class="mog-feature-row" style="gap:8px;">
                                <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Max</span>
                                <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                    <input type="range" class="mog-slider" id="mog-final-range-max" min="50000" max="99000" step="1000" value="97000" style="width:100%;margin:0;">
                                </div>
                                <span id="mog-final-range-max-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">9.7</span>
                            </div>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Opp Cap</span>
                            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                <input type="range" class="mog-slider" id="mog-opp-score" min="1000" max="50000" step="1000" value="15000" style="width:100%;margin:0;">
                            </div>
                            <span id="mog-opp-score-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">1.5</span>
                        </div>
                    </div>

                    <div class="mog-feature-box-title">Preview</div>
                    <div class="mog-feature-box" style="padding:10px 12px;">
                        <div class="mog-score-big" id="mog-score-preview-num" style="color:#ef4444">9.4</div>
                        <div class="mog-score-tier" id="mog-score-preview-tier" style="color:#ef4444">🍎 Adam</div>
                    </div>
                </div>

               <!-- FUN TAB -->
                <div class="mog-panel" data-panel="fun">

                    <div class="mog-feature-box-title">Camera Spoof</div>
                    <div class="mog-feature-box">
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Enable</span>
                            <label class="mog-switch">
                                <input type="checkbox" id="mog-camspoof-toggle">
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Source</span>
                            <div style="display:flex;gap:4px;">
                               <button class="mog-src-btn active" data-src="video" style="padding:3px 10px;border-radius:6px;font-family:monospace;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:0.1em;cursor:pointer;transition:all 0.2s;background:rgba(var(--mog-accent-rgb),0.15);color:var(--mog-accent);border:1px solid rgba(var(--mog-accent-rgb),0.4);">Video</button>
<button class="mog-src-btn" data-src="image" style="padding:3px 10px;border-radius:6px;font-family:monospace;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:0.1em;cursor:pointer;transition:all 0.2s;background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.1);">Image</button>
                            </div>
                        </div>
                        <div class="mog-feature-row" id="mog-src-video-section">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">File</span>
                            <div id="mog-video-pick-btn" style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;cursor:pointer;overflow:hidden;">
                                <span id="mog-video-name" style="font-size:9px;color:rgba(255,255,255,0.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📂 No file selected</span>
                            </div>
                            <input type="file" id="mog-video-input" accept="video/*" style="display:none">
                        </div>
                        <div class="mog-feature-row" id="mog-src-image-section" style="display:none;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">File</span>
                            <div id="mog-image-pick-btn" style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;cursor:pointer;overflow:hidden;">
                                <span id="mog-image-name" style="font-size:9px;color:rgba(255,255,255,0.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📂 No file selected</span>
                            </div>
                            <input type="file" id="mog-image-input" accept="image/*" style="display:none">
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Speed</span>
                            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                <input type="range" class="mog-slider" id="mog-camspeed" min="0.25" max="3.0" step="0.25" value="1.0" style="width:100%;margin:0;">
                            </div>
                            <span id="mog-camspeed-val" class="val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">1.0x</span>
                        </div>
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Loop</span>
                            <label class="mog-switch">
                                <input type="checkbox" id="mog-camloop-toggle" checked>
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Mirror</span>
                            <label class="mog-switch">
                                <input type="checkbox" id="mog-cammirror-toggle">
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                    </div>

                    <div class="mog-feature-box-title">Overlays</div>
                    <div class="mog-feature-box">
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Ban</span>
                            <label class="mog-switch">
                                <input type="checkbox" id="mog-ban-overlay-toggle">
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Loading</span>
                            <label class="mog-switch">
                                <input type="checkbox" id="mog-loading-overlay-toggle">
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                    </div>

                    <div class="mog-feature-box-title">Status</div>
                    <div class="mog-feature-box" style="padding:10px 12px;" id="mog-overlay-status">
                        <div style="font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:0.18em;color:#7C81A5;margin-bottom:4px;">Active overlay</div>
                        <div id="mog-overlay-status-text" style="font-size:14px;font-weight:900;color:rgba(255,255,255,0.3);">None active</div>
                    </div>
                    <div class="mog-feature-box-title">Particles</div>
                    <div class="mog-feature-box">
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Enable</span>
                            <label class="mog-switch">
                                <input type="checkbox" id="mog-particles-toggle">
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Count</span>
                            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                <input type="range" class="mog-slider" id="mog-particles-count" min="10" max="300" step="10" value="80" style="width:100%;margin:0;">
                            </div>
                            <span id="mog-particles-count-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">80</span>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Size</span>
                            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                <input type="range" class="mog-slider" id="mog-particles-size" min="1" max="20" step="1" value="5" style="width:100%;margin:0;">
                            </div>
                            <span id="mog-particles-size-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">5px</span>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Speed</span>
                            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                <input type="range" class="mog-slider" id="mog-particles-speed" min="0.2" max="5.0" step="0.2" value="1.0" style="width:100%;margin:0;">
                            </div>
                            <span id="mog-particles-speed-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">1.0x</span>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Drift</span>
                            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                <input type="range" class="mog-slider" id="mog-particles-drift" min="0" max="3.0" step="0.1" value="0.5" style="width:100%;margin:0;">
                            </div>
                            <span id="mog-particles-drift-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">0.5</span>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Opacity</span>
                            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                <input type="range" class="mog-slider" id="mog-particles-opacity" min="5" max="100" step="5" value="70" style="width:100%;margin:0;">
                            </div>
                            <span id="mog-particles-opacity-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">70%</span>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Color</span>
                            <input type="color" id="mog-particles-color" value="#ffffff" style="width:28px;height:20px;border:none;background:none;cursor:pointer;border-radius:4px;">
                            <span class="mog-label" style="margin:0 0 0 8px;white-space:nowrap;">Rainbow</span>
                            <label class="mog-switch" style="margin-left:4px;">
                                <input type="checkbox" id="mog-particles-rainbow">
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Shape</span>
                            <div style="display:flex;gap:4px;flex-wrap:wrap;">
                                <button class="mog-shape-btn active" data-shape="circle" style="padding:3px 7px;border-radius:6px;font-family:monospace;font-size:8px;font-weight:900;text-transform:uppercase;cursor:pointer;transition:all 0.2s;background:rgba(var(--mog-accent-rgb),0.15);color:var(--mog-accent);border:1px solid rgba(var(--mog-accent-rgb),0.4);">●</button>
                                <button class="mog-shape-btn" data-shape="star" style="padding:3px 7px;border-radius:6px;font-family:monospace;font-size:8px;font-weight:900;text-transform:uppercase;cursor:pointer;transition:all 0.2s;background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.1);">★</button>
                                <button class="mog-shape-btn" data-shape="square" style="padding:3px 7px;border-radius:6px;font-family:monospace;font-size:8px;font-weight:900;text-transform:uppercase;cursor:pointer;transition:all 0.2s;background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.1);">■</button>
                                <button class="mog-shape-btn" data-shape="heart" style="padding:3px 7px;border-radius:6px;font-family:monospace;font-size:8px;font-weight:900;text-transform:uppercase;cursor:pointer;transition:all 0.2s;background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.1);">♥</button>
                            </div>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Glow</span>
                            <label class="mog-switch">
                                <input type="checkbox" id="mog-particles-glow" checked>
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                            <span class="mog-label" style="margin:0 0 0 10px;white-space:nowrap;">Wobble</span>
                            <label class="mog-switch" style="margin-left:4px;">
                                <input type="checkbox" id="mog-particles-wobble" checked>
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                    </div>

                </div>

                <!-- MISC TAB -->
                <div class="mog-panel" data-panel="misc">

                    <div class="mog-feature-box-title">Boost</div>
<div class="mog-feature-box">
    <div class="mog-feature-row">
        <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Mode</span>
        <div style="display:flex;gap:4px;">
            <button class="mog-mode-btn active" data-mode="button" style="padding:3px 10px;border-radius:6px;font-family:'Ebisu',monospace;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:0.1em;cursor:pointer;transition:all 0.2s;background:rgba(var(--mog-accent-rgb),0.15);color:var(--mog-accent);border:1px solid rgba(var(--mog-accent-rgb),0.4);">🖱 Button</button>
            <button class="mog-mode-btn" data-mode="bind" style="padding:3px 10px;border-radius:6px;font-family:'Ebisu',monospace;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:0.1em;cursor:pointer;transition:all 0.2s;background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.1);">⌨ Bind</button>
        </div>
    </div>
    <div id="mog-hold-btn-settings">
        <div class="mog-feature-row">
            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Color</span>
            <input type="color" id="mog-holdcolor" value="#7c3aed" style="width:28px;height:20px;border:none;background:none;cursor:pointer;border-radius:4px;">
            <span class="mog-label" style="margin:0 4px 0 8px;">Alpha</span>
            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                <input type="range" class="mog-slider" id="mog-holdalpha" min="10" max="100" step="5" value="80" style="width:100%;margin:0;">
            </div>
            <span id="mog-holdalpha-val" style="font-size:10px;color:var(--mog-accent);min-width:32px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">80%</span>
        </div>
        <div class="mog-feature-row" style="gap:8px;">
            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Size</span>
            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                <input type="range" class="mog-slider" id="mog-holdsize" min="30" max="120" step="2" value="54" style="width:100%;margin:0;">
            </div>
            <span id="mog-holdsize-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">54px</span>
        </div>
    </div>
    <div id="mog-hold-bind-settings" style="display:none;">
        <div class="mog-feature-row" style="gap:8px;">
            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Key</span>
            <input type="text" id="mog-holdkey" placeholder="Click then press key..." style="flex:1;background:#181b30;border:1px solid #1a3a28;border-radius:6px;padding:2px 8px;color:#c4b5fd;font-family:'Ebisu',monospace;font-size:10px;outline:none;transition:border-color 0.2s;height:22px;">
            <button id="mog-holdkey-clear" style="margin-left:4px;padding:2px 8px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);border-radius:6px;color:#fca5a5;font-family:'Ebisu',monospace;font-size:9px;cursor:pointer;">CLR</button>
        </div>
    </div>
    <div class="mog-feature-row" style="gap:8px;">
        <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Boost %</span>
        <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
            <input type="range" class="mog-slider" id="mog-holdpct" min="5" max="200" step="5" value="50" style="width:100%;margin:0;">
        </div>
        <span id="mog-holdpct-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">+50%</span>
    </div>
    <div class="mog-feature-row" style="gap:8px;">
        <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Random ±</span>
        <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
            <input type="range" class="mog-slider" id="mog-holdrand" min="0" max="50" step="1" value="10" style="width:100%;margin:0;">
        </div>
        <span id="mog-holdrand-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">±10%</span>
    </div>
    <div class="mog-feature-row" style="gap:8px;">
        <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Ramp ms</span>
        <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
            <input type="range" class="mog-slider" id="mog-holddur" min="100" max="3000" step="100" value="1000" style="width:100%;margin:0;">
        </div>
        <span id="mog-holddur-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">1000ms</span>
    </div>
</div>



                    <div class="mog-feature-box-title">Toggles</div>
                    <div class="mog-feature-box">
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Frames</span>
                            <label class="mog-switch">
                                <input type="checkbox" id="mog-boost-toggle" checked>
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Finalize</span>
                            <label class="mog-switch">
                                <input type="checkbox" id="mog-finalize-toggle" checked>
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Debug</span>
                            <label class="mog-switch">
                                <input type="checkbox" id="mog-debug-toggle" checked>
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                    </div>
<div class="mog-feature-box-title">Appearance</div>
                    <div class="mog-feature-box">
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Accent</span>
                            <input type="color" id="mog-accent-color" value="#80FF00" style="width:28px;height:20px;border:none;background:none;cursor:pointer;border-radius:4px;">
                            <span class="mog-label" style="margin:0 0 0 10px;white-space:nowrap;min-width:48px;">Preview</span>
                            <span id="mog-accent-preview" style="font-size:9px;font-weight:900;letter-spacing:0.15em;color:var(--mog-accent);text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">●  ACTIVE</span>
                        </div>
                    </div>

                    <div class="mog-feature-box-title">Watermark</div>
                    <div class="mog-feature-box">
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Show</span>
                            <label class="mog-switch">
                                <input type="checkbox" id="mog-wm-show" checked>
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Alpha</span>
                            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                <input type="range" class="mog-slider" id="mog-wm-alpha" min="0" max="100" step="5" value="20" style="width:100%;margin:0;">
                            </div>
                            <span id="mog-wm-alpha-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">20%</span>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Font Size</span>
                            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                <input type="range" class="mog-slider" id="mog-wm-size" min="7" max="18" step="1" value="9" style="width:100%;margin:0;">
                            </div>
                            <span id="mog-wm-size-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">9px</span>
                        </div>
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Padding</span>
                            <div style="flex:1;background:#181b30;border-radius:6px;padding:0 8px;height:22px;display:flex;align-items:center;border:1px solid #1a3a28;">
                                <input type="range" class="mog-slider" id="mog-wm-padding" min="2" max="20" step="1" value="14" style="width:100%;margin:0;">
                            </div>
                            <span id="mog-wm-padding-val" style="font-size:10px;color:var(--mog-accent);min-width:36px;text-align:right;text-shadow:0 0 8px rgba(var(--mog-accent-rgb),0.6);">14px</span>
                        </div>
                        <div class="mog-feature-row">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Background</span>
                            <label class="mog-switch">
                                <input type="checkbox" id="mog-wm-bg" checked>
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                            <span class="mog-label" style="margin:0 0 0 10px;white-space:nowrap;">Border</span>
                            <label class="mog-switch" style="margin-left:4px;">
                                <input type="checkbox" id="mog-wm-border" checked>
                                <div class="mog-switch-track"></div>
                                <div class="mog-switch-thumb"></div>
                            </label>
                        </div>
                    </div>
                    <div class="mog-feature-box-title">Menu Keybind</div>
                    <div class="mog-feature-box">
                        <div class="mog-feature-row" style="gap:8px;">
                            <span class="mog-label" style="margin:0;white-space:nowrap;min-width:72px;">Toggle Key</span>
                            <input type="text" id="mog-menukey" placeholder="key..." value="h" style="width:38px;flex:none;background:#181b30;border:1px solid #1a3a28;border-radius:6px;padding:2px 8px;color:#c4b5fd;font-family:'Ebisu',monospace;font-size:10px;outline:none;transition:border-color 0.2s;height:22px;text-align:center;">
                            <button id="mog-menukey-clear" style="margin-left:4px;padding:2px 8px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);border-radius:6px;color:#fca5a5;font-family:'Ebisu',monospace;font-size:9px;cursor:pointer;flex-shrink:0;">CLR</button>
                        </div>
                    </div>


            </div>

        `;
        document.body.appendChild(root);

        // Fix initial panel opacity — CSS sets opacity:0 on all panels including active
        const initialPanel = root.querySelector('.mog-panel.active');
        if (initialPanel) {
            initialPanel.style.opacity = '1';
            initialPanel.style.transform = 'translateY(0)';
        }

        // ── Wire up toggle button
        root.style.transition = 'opacity 0.2s ease, transform 0.2s cubic-bezier(0.34,1.56,0.64,1)';
        root.style.transformOrigin = 'center center';

        // Center on screen by default
        root.style.display = 'block';
        root.style.bottom = 'auto';
        root.style.right = 'auto';
        root.style.top = '50%';
        root.style.left = '50%';
        root.style.transform = 'translate(-50%, -50%) scale(1)';
        root.style.opacity = '1';
        root.style.transformOrigin = 'center center';

        // ── Menu drag ─────────────────────────────────────────────────────────
        let _menuDragging = false, _menuDragOffX = 0, _menuDragOffY = 0;
        // Use header as drag handle
        const _menuHeader = root.querySelector('#mog-header');
        _menuHeader.style.cursor = 'grab';
        _menuHeader.addEventListener('mousedown', function(e) {
            if (e.target.matches('input, button, label, .mog-tab')) return;
            _menuDragging = true;
            const rect = root.getBoundingClientRect();
            _menuDragOffX = e.clientX - rect.left;
            _menuDragOffY = e.clientY - rect.top;
            root.style.transition = 'opacity 0.2s ease';
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!_menuDragging) return;
            const x = e.clientX - _menuDragOffX;
            const y = e.clientY - _menuDragOffY;
            root.style.left = x + 'px';
            root.style.top = y + 'px';
            root.style.transform = 'none';
        });
        document.addEventListener('mouseup', function() {
            if (_menuDragging) {
                _menuDragging = false;
                _menuHeader.style.cursor = 'grab';
            }
        });
        _menuHeader.addEventListener('touchstart', function(e) {
            if (e.target.matches('input, button, label, .mog-tab')) return;
            _menuDragging = true;
            const rect = root.getBoundingClientRect();
            _menuDragOffX = e.touches[0].clientX - rect.left;
            _menuDragOffY = e.touches[0].clientY - rect.top;
        }, { passive: true });
        document.addEventListener('touchmove', function(e) {
            if (!_menuDragging) return;
            const x = e.touches[0].clientX - _menuDragOffX;
            const y = e.touches[0].clientY - _menuDragOffY;
            root.style.left = x + 'px';
            root.style.top = y + 'px';
            root.style.transform = 'none';
        }, { passive: true });
        document.addEventListener('touchend', function() { _menuDragging = false; });

        function _toggleMenu() {
            const _wasDragged = root.style.transform === 'none';
            if (root.style.display === 'none' || root.style.display === '') {
                root.style.display = 'block';
                root.style.opacity = '0';
                if (!_wasDragged) root.style.transform = 'translate(-50%, -50%) scale(0.92)';
                requestAnimationFrame(() => {
                    root.style.opacity = '1';
                    if (!_wasDragged) root.style.transform = 'translate(-50%, -50%) scale(1)';
                });
            } else {
                root.style.opacity = '0';
                setTimeout(() => { root.style.display = 'none'; }, 200);
            }
        }

        btn.addEventListener('click', _toggleMenu);

        // H-key toggle (default), configurable
        let _menuKey = 'KeyH';
        document.addEventListener('keydown', function(e) {
            if (e.code === _menuKey && !e.target.matches('input[type="text"], input[type="search"], textarea')) {
                _toggleMenu();
            }
        });

        // Add transition style to panels
        let _tabSwitching = false;

        function measureHeight(panel) {
            const prevDisplay = panel.style.display;
            const prevVisibility = panel.style.visibility;
            const prevPosition = panel.style.position;
            panel.style.display = 'block';
            panel.style.visibility = 'hidden';
            panel.style.position = 'relative';
            const h = panel.offsetHeight;
            panel.style.display = prevDisplay;
            panel.style.visibility = prevVisibility;
            panel.style.position = prevPosition;
            return h;
        }

        function switchTab(tabName) {
            if (_tabSwitching) return;
            const current = root.querySelector('.mog-panel.active');
            const next = root.querySelector(`[data-panel="${tabName}"]`);
            if (!next || current === next) return;

            _tabSwitching = true;

            const body = document.getElementById('mog-body');
            const currentH = current ? current.offsetHeight : 0;

            // Update tab active state immediately
            root.querySelectorAll('.mog-tab').forEach(t => t.classList.remove('active'));
            root.querySelector(`.mog-tab[data-tab="${tabName}"]`).classList.add('active');

            // Phase 1: fade current out
            if (current) {
                current.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
                current.style.opacity = '0';
                current.style.transform = 'translateY(-5px)';
            }

            // Lock body height at current value
            body.style.height = currentH + 'px';
            body.style.overflow = 'hidden';
            body.style.transition = 'none';

            setTimeout(() => {
                // Hide current
                if (current) {
                    current.classList.remove('active');
                    current.style.display = 'none';
                }

                // Show next hidden
                next.style.display = 'block';
                next.style.visibility = 'hidden';
                next.style.opacity = '0';
                next.style.transform = 'translateY(5px)';
                next.style.transition = 'none';
                next.classList.add('active');

                // Release body to auto so it adopts natural height including padding
                body.style.transition = 'none';
                body.style.overflow = 'visible';
                body.style.height = 'auto';

                // Measure the body's true natural height
                void body.offsetHeight;
                const targetH = body.offsetHeight;

                // Re-lock to currentH before animating
                body.style.overflow = 'hidden';
                body.style.height = currentH + 'px';
                void body.offsetHeight;

                next.style.visibility = '';

                // Animate body height to exact natural value
                body.style.transition = 'height 0.25s cubic-bezier(0.4,0,0.2,1)';
                body.style.height = targetH + 'px';

                // Fade next in
                setTimeout(() => {
                    next.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
                    next.style.opacity = '1';
                    next.style.transform = 'translateY(0)';
                }, 60);

                // Cleanup — auto matches targetH exactly so no jump
                setTimeout(() => {
                    body.style.transition = 'none';
                    body.style.overflow = '';
                    body.style.height = 'auto';
                    _tabSwitching = false;
                }, 280);

            }, 160);
        }

        root.querySelectorAll('.mog-tab').forEach(tab => {
            tab.addEventListener('click', () => switchTab(tab.dataset.tab));
        });

        // ── Enable toggle
        document.getElementById('mog-enable-toggle').addEventListener('change', function() {
            CONFIG.enabled = this.checked;
            document.getElementById('mog-enabled-badge').textContent = this.checked ? 'ENABLED' : 'DISABLED';
            document.getElementById('mog-enabled-badge').style.color = this.checked ? '#86efac' : '#fca5a5';
        });

        // ── Final score slider
        document.getElementById('mog-final-score').addEventListener('input', function() {
            CONFIG.myFinalScore = this.value;
            const v = (parseInt(this.value) / 10000).toFixed(1);
            document.getElementById('mog-final-score-val').textContent = v;
            updateScorePreview();
        });

        // ── Hold tab sliders
        document.getElementById('mog-holdpct').addEventListener('input', function() {
            CONFIG.boostPercent = parseInt(this.value);
            document.getElementById('mog-holdpct-val').textContent = '+' + this.value + '%';
        });
        document.getElementById('mog-holdrand').addEventListener('input', function() {
            CONFIG.boostRandom = parseInt(this.value);
            document.getElementById('mog-holdrand-val').textContent = '±' + this.value + '%';
        });
        document.getElementById('mog-holddur').addEventListener('input', function() {
            CONFIG.boostDuration = parseInt(this.value);
            document.getElementById('mog-holddur-val').textContent = this.value + 'ms';
        });

        // ── Mode toggle (button vs bind)
        let _holdMode = 'button'; // 'button' | 'bind'
        document.querySelectorAll('.mog-mode-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                _holdMode = this.dataset.mode;
                document.querySelectorAll('.mog-mode-btn').forEach(b => {
                    const isActive = b.dataset.mode === _holdMode;
                    b.style.background = isActive ? 'rgba(var(--mog-accent-rgb),0.15)' : 'rgba(255,255,255,0.04)';
                    b.style.color = isActive ? 'var(--mog-accent)' : 'rgba(255,255,255,0.4)';
                    b.style.borderColor = isActive ? 'rgba(var(--mog-accent-rgb),0.4)' : 'rgba(255,255,255,0.1)';
                });
                const btnSettings = document.getElementById('mog-hold-btn-settings');
                const bindSettings = document.getElementById('mog-hold-bind-settings');
                if (_holdMode === 'button') {
                    holdBtn.style.opacity = '1';
                    holdBtn.style.pointerEvents = 'auto';
                    holdBtn.style.transform = 'scale(1)';
                    btnSettings.style.maxHeight = '200px';
                    btnSettings.style.opacity = '1';
                    bindSettings.style.maxHeight = '0';
                    bindSettings.style.opacity = '0';
                    setTimeout(() => { bindSettings.style.display = 'none'; btnSettings.style.display = 'block'; }, 200);
                } else {
                    holdBtn.style.opacity = '0';
                    holdBtn.style.pointerEvents = 'none';
                    holdBtn.style.transform = 'scale(0.8)';
                    bindSettings.style.display = 'block';
                    btnSettings.style.maxHeight = '0';
                    btnSettings.style.opacity = '0';
                    setTimeout(() => {
                        btnSettings.style.display = 'none';
                        bindSettings.style.maxHeight = '200px';
                        bindSettings.style.opacity = '1';
                    }, 10);
                }
            });
        });

        // Animate the settings sections
        const btnSettingsEl = document.getElementById('mog-hold-btn-settings');
        const bindSettingsEl = document.getElementById('mog-hold-bind-settings');
        btnSettingsEl.style.cssText += 'max-height:200px;opacity:1;overflow:hidden;transition:max-height 0.25s ease,opacity 0.2s ease;';
        bindSettingsEl.style.cssText += 'max-height:0;opacity:0;overflow:hidden;transition:max-height 0.25s ease,opacity 0.2s ease;';

        // ── Draggable hold button
        let _holdBtnColor = '#7c3aed';
        let _holdBtnAlpha = 0.8;
        let _holdKey = null;

        const holdBtn = document.createElement('div');
        holdBtn.id = 'mog-hold-btn';
        holdBtn.textContent = '📈';
        holdBtn.style.cssText = `
            position: fixed; bottom: 20px; left: 20px; z-index: 999998;
            width: ${CONFIG.holdBtnSize}px; height: ${CONFIG.holdBtnSize}px;
            border-radius: ${Math.round(CONFIG.holdBtnSize * 0.26)}px;
            background: rgba(124,58,237,0.8);
            border: 1px solid rgba(255,255,255,0.2);
            box-shadow: 0 0 20px rgba(124,58,237,0.4);
            display: flex; align-items: center; justify-content: center;
            font-size: ${Math.round(CONFIG.holdBtnSize * 0.4)}px;
            cursor: pointer; user-select: none;
            backdrop-filter: blur(10px);
            transition: box-shadow 0.3s ease, transform 0.3s cubic-bezier(0.34,1.56,0.64,1), opacity 0.3s ease, width 0.2s ease, height 0.2s ease, border-radius 0.2s ease, font-size 0.2s ease;
        `;
        document.body.appendChild(holdBtn);

        // ── WATERMARK ─────────────────────────────────────────────────────────
        const _wm = document.createElement('div');
        _wm.id = 'mog-watermark';
        _wm.textContent = 'hitlock client | discord: @42pz | lifetime 10$';
        function applyWmStyle() {
            const rect = _wm ? _wm.getBoundingClientRect() : null;
            const hasDragged = _wm && _wm.style.left !== '' && _wm.style.left !== 'auto';
            _wm.style.cssText = `
                position: fixed;
                ${hasDragged
                    ? `left: ${rect.left}px; top: ${rect.top}px;`
                    : 'bottom: 80px; right: 20px;'}
                z-index: 999997;
                padding: ${CONFIG.wmPaddingV}px ${CONFIG.wmPaddingH}px;
                border-radius: 10px;
                background: ${CONFIG.wmBg ? `rgba(var(--mog-accent-rgb),${CONFIG.wmAlpha / 100})` : 'transparent'};
                border: ${CONFIG.wmBorder ? '1px solid rgba(var(--mog-accent-rgb),0.3)' : 'none'};
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                color: rgba(255,255,255,0.35);
                font-family: monospace;
                font-size: ${CONFIG.wmFontSize}px;
                font-weight: 700;
                letter-spacing: 0.1em;
                white-space: nowrap;
                cursor: grab;
                user-select: none;
                pointer-events: auto;
            `;
        }
        applyWmStyle();
        document.body.appendChild(_wm);

        // Watermark drag
        let _wmDragging = false, _wmDragOffX = 0, _wmDragOffY = 0;
        _wm.addEventListener('mousedown', function(e) {
            _wmDragging = true;
            _wmDragOffX = e.clientX - _wm.getBoundingClientRect().left;
            _wmDragOffY = e.clientY - _wm.getBoundingClientRect().top;
            _wm.style.cursor = 'grabbing';
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!_wmDragging) return;
            _wm.style.left = (e.clientX - _wmDragOffX) + 'px';
            _wm.style.top = (e.clientY - _wmDragOffY) + 'px';
            _wm.style.bottom = 'auto';
            _wm.style.right = 'auto';
        });
        document.addEventListener('mouseup', function() {
            if (_wmDragging) { _wmDragging = false; _wm.style.cursor = 'grab'; }
        });
        _wm.addEventListener('touchstart', function(e) {
            _wmDragging = true;
            _wmDragOffX = e.touches[0].clientX - _wm.getBoundingClientRect().left;
            _wmDragOffY = e.touches[0].clientY - _wm.getBoundingClientRect().top;
        }, { passive: true });
        document.addEventListener('touchmove', function(e) {
            if (!_wmDragging) return;
            _wm.style.left = (e.touches[0].clientX - _wmDragOffX) + 'px';
            _wm.style.top = (e.touches[0].clientY - _wmDragOffY) + 'px';
            _wm.style.bottom = 'auto';
            _wm.style.right = 'auto';
        }, { passive: true });
        document.addEventListener('touchend', function() { _wmDragging = false; });

        function updateHoldBtnStyle() {
            const r = parseInt(_holdBtnColor.slice(1,3),16);
            const g = parseInt(_holdBtnColor.slice(3,5),16);
            const b = parseInt(_holdBtnColor.slice(5,7),16);
            holdBtn.style.background = `rgba(${r},${g},${b},${_holdBtnAlpha})`;
            holdBtn.style.boxShadow = _boostHeld
                ? `0 0 45px rgba(${r},${g},${b},0.95), 0 0 15px rgba(${r},${g},${b},0.6)`
            : `0 0 20px rgba(${r},${g},${b},0.4)`;
        }

        document.getElementById('mog-holdcolor').addEventListener('input', function() {
            _holdBtnColor = this.value;
            updateHoldBtnStyle();
        });
        document.getElementById('mog-holdalpha').addEventListener('input', function() {
            _holdBtnAlpha = parseInt(this.value) / 100;
            document.getElementById('mog-holdalpha-val').textContent = this.value + '%';
            updateHoldBtnStyle();
        });
        document.getElementById('mog-holdsize').addEventListener('input', function() {
            const sz = parseInt(this.value);
            CONFIG.holdBtnSize = sz;
            document.getElementById('mog-holdsize-val').textContent = sz + 'px';
            holdBtn.style.width = sz + 'px';
            holdBtn.style.height = sz + 'px';
            holdBtn.style.borderRadius = Math.round(sz * 0.26) + 'px';
            holdBtn.style.fontSize = Math.round(sz * 0.4) + 'px';
        });

        // Drag logic
        let _dragging = false, _dragOffX = 0, _dragOffY = 0, _dragMoved = false;
        holdBtn.addEventListener('mousedown', function(e) {
            _dragging = true; _dragMoved = false;
            _dragOffX = e.clientX - holdBtn.getBoundingClientRect().left;
            _dragOffY = e.clientY - holdBtn.getBoundingClientRect().top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!_dragging) return;
            _dragMoved = true;
            holdBtn.style.left = (e.clientX - _dragOffX) + 'px';
            holdBtn.style.top  = (e.clientY - _dragOffY) + 'px';
            holdBtn.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', function() { _dragging = false; });

        holdBtn.addEventListener('touchstart', function(e) {
            _dragging = true; _dragMoved = false;
            const t = e.touches[0];
            _dragOffX = t.clientX - holdBtn.getBoundingClientRect().left;
            _dragOffY = t.clientY - holdBtn.getBoundingClientRect().top;
        }, { passive: true });
        document.addEventListener('touchmove', function(e) {
            if (!_dragging) return;
            _dragMoved = true;
            const t = e.touches[0];
            holdBtn.style.left = (t.clientX - _dragOffX) + 'px';
            holdBtn.style.top  = (t.clientY - _dragOffY) + 'px';
            holdBtn.style.bottom = 'auto';
        }, { passive: true });
        document.addEventListener('touchend', function() { _dragging = false; });

        // Hold press logic
        function startHold() {
            if (_boostHeld) return;
            _boostHeld = true;
            holdBtn.style.transform = 'scale(0.88)';
            updateHoldBtnStyle();
            rampBoost(true);
        }
        function endHold() {
            if (!_boostHeld) return;
            _boostHeld = false;
            holdBtn.style.transform = 'scale(1)';
            updateHoldBtnStyle();
            rampBoost(false);
        }

        holdBtn.addEventListener('mousedown', function(e) {
            setTimeout(() => { if (!_dragMoved) startHold(); }, 80);
        });
        document.addEventListener('mouseup', function() {
            if (_boostHeld && _holdMode === 'button') endHold();
        });
        holdBtn.addEventListener('touchstart', function() {
            setTimeout(() => { if (!_dragMoved) startHold(); }, 80);
        }, { passive: true });
        document.addEventListener('touchend', function() {
            if (_boostHeld && _holdMode === 'button') endHold();
        });

        // ── Key bind
        const keyInput = document.getElementById('mog-holdkey');
        let _listeningForKey = false;
        keyInput.addEventListener('focus', function() {
            _listeningForKey = true;
            this.value = '— press a key —';
            this.style.borderColor = '#c084fc';
            this.style.color = '#c084fc';
        });
        keyInput.addEventListener('keydown', function(e) {
            if (!_listeningForKey) return;
            e.preventDefault();
            _holdKey = e.code;
            this.value = e.key === ' ' ? 'Space' : e.key;
            this.style.borderColor = 'rgba(34,197,94,0.5)';
            this.style.color = '#86efac';
            _listeningForKey = false;
            this.blur();
        });
        document.getElementById('mog-holdkey-clear').addEventListener('click', function() {
            _holdKey = null;
            keyInput.value = '';
            keyInput.style.borderColor = 'rgba(255,255,255,0.12)';
            keyInput.style.color = '#c4b5fd';
        });
        document.addEventListener('keydown', function(e) {
            if (_holdMode === 'bind' && _holdKey && e.code === _holdKey && !e.repeat) startHold();
        });
        document.addEventListener('keyup', function(e) {
            if (_holdMode === 'bind' && _holdKey && e.code === _holdKey) endHold();
        });

        // ── Opp score slider
        document.getElementById('mog-opp-score').addEventListener('input', function() {
            CONFIG.oppFinalScore = this.value;
            document.getElementById('mog-opp-score-val').textContent = (parseInt(this.value) / 10000).toFixed(2);
        });

        // ── Boost slider
        document.getElementById('mog-boost-slider').addEventListener('input', function() {
            CONFIG.myScoreBoost = parseFloat(this.value);
            document.getElementById('mog-boost-val').textContent = CONFIG.myScoreBoost.toFixed(2) + 'x';
        });

        // ── Live boost mode toggle
        function setBoostModeUI(mode) {
            CONFIG.boostMode = mode;
            document.querySelectorAll('.mog-boost-mode-btn').forEach(b => {
                const on = b.dataset.bmode === mode;
                b.style.background = on ? 'rgba(var(--mog-accent-rgb),0.15)' : 'rgba(255,255,255,0.04)';
                b.style.color = on ? 'var(--mog-accent)' : 'rgba(255,255,255,0.4)';
                b.style.borderColor = on ? 'rgba(var(--mog-accent-rgb),0.4)' : 'rgba(255,255,255,0.1)';
            });
            const multSec = document.getElementById('mog-boost-mult-section');
            const rangeSec = document.getElementById('mog-boost-range-section');
            if (mode === 'multiplier') {
                multSec.style.display = 'block'; rangeSec.style.display = 'none';
            } else {
                multSec.style.display = 'none'; rangeSec.style.display = 'block';
            }
        }
        document.querySelectorAll('.mog-boost-mode-btn').forEach(b => {
            b.addEventListener('click', function() { setBoostModeUI(this.dataset.bmode); });
        });
        document.getElementById('mog-boost-range-min').addEventListener('input', function() {
            CONFIG.boostRangeMin = parseFloat(this.value);
            document.getElementById('mog-boost-range-min-val').textContent = CONFIG.boostRangeMin.toFixed(2) + 'x';
        });
        document.getElementById('mog-boost-range-max').addEventListener('input', function() {
            CONFIG.boostRangeMax = parseFloat(this.value);
            document.getElementById('mog-boost-range-max-val').textContent = CONFIG.boostRangeMax.toFixed(2) + 'x';
        });

        // ── Final score mode toggle
        function setFinalModeUI(mode) {
            CONFIG.finalScoreMode = mode;
            document.querySelectorAll('.mog-final-mode-btn').forEach(b => {
                const on = b.dataset.fmode === mode;
                b.style.background = on ? 'rgba(var(--mog-accent-rgb),0.15)' : 'rgba(255,255,255,0.04)';
                b.style.color = on ? 'var(--mog-accent)' : 'rgba(255,255,255,0.4)';
                b.style.borderColor = on ? 'rgba(var(--mog-accent-rgb),0.4)' : 'rgba(255,255,255,0.1)';
            });
            document.getElementById('mog-final-fixed-section').style.display = mode === 'fixed' ? 'block' : 'none';
            document.getElementById('mog-final-range-section').style.display = mode === 'range' ? 'block' : 'none';
            updateScorePreview();
        }
        document.querySelectorAll('.mog-final-mode-btn').forEach(b => {
            b.addEventListener('click', function() { setFinalModeUI(this.dataset.fmode); });
        });
        document.getElementById('mog-final-range-min').addEventListener('input', function() {
            CONFIG.finalScoreRangeMin = parseInt(this.value);
            document.getElementById('mog-final-range-min-val').textContent = (CONFIG.finalScoreRangeMin / 10000).toFixed(1);
            updateScorePreview();
        });
        document.getElementById('mog-final-range-max').addEventListener('input', function() {
            CONFIG.finalScoreRangeMax = parseInt(this.value);
            document.getElementById('mog-final-range-max-val').textContent = (CONFIG.finalScoreRangeMax / 10000).toFixed(1);
            updateScorePreview();
        });
        // Range preview randomizer — fires every 2s when in range mode
        setInterval(() => {
            if (CONFIG.finalScoreMode === 'range') updateScorePreview();
        }, 2000);

        // ── Cap slider
        // ── Cap slider — writes directly to CONFIG so send intercept reads it
        document.getElementById('mog-cap-slider').addEventListener('input', function() {
            CONFIG.frameCap = parseInt(this.value);
            document.getElementById('mog-cap-val').textContent = (CONFIG.frameCap / 10000).toFixed(1);
            // Force Zustand setMyScore to re-read the new cap immediately
            _lockedFinalTarget = null;
        });

        // ── Boost frame toggle
        let _boostFrames = true;
        document.getElementById('mog-boost-toggle').addEventListener('change', function() {
            _boostFrames = this.checked;
        });

        // ── Finalize toggle
        let _boostFinalize = true;
        document.getElementById('mog-finalize-toggle').addEventListener('change', function() {
            _boostFinalize = this.checked;
        });

        // ── Debug toggle
        document.getElementById('mog-debug-toggle').addEventListener('change', function() {
            CONFIG.debug = this.checked;
        });

        // ── Menu keybind
        const menuKeyInput = document.getElementById('mog-menukey');
        let _menuKeyListening = false;
        menuKeyInput.addEventListener('focus', function() {
            _menuKeyListening = true;
            this.value = '— press a key —';
            this.style.borderColor = '#c084fc';
            this.style.color = '#c084fc';
        });
        menuKeyInput.addEventListener('keydown', function(e) {
            if (!_menuKeyListening) return;
            e.preventDefault();
            _menuKey = e.code;
            this.value = e.key === ' ' ? 'Space' : e.key;
            this.style.borderColor = 'rgba(34,197,94,0.5)';
            this.style.color = '#86efac';
            _menuKeyListening = false;
            this.blur();
        });
        // ── Accent color picker
        function setAccentColor(hex) {
            const r = parseInt(hex.slice(1,3),16);
            const g = parseInt(hex.slice(3,5),16);
            const b = parseInt(hex.slice(5,7),16);
            document.documentElement.style.setProperty('--mog-accent', hex);
            document.documentElement.style.setProperty('--mog-accent-rgb', `${r},${g},${b}`);
            // also update mog-btn green text
            const mogBtn = document.getElementById('mog-btn');
            if (mogBtn) mogBtn.style.color = hex;
        }
        document.getElementById('mog-accent-color').addEventListener('input', function() {
            setAccentColor(this.value);
        });

        // ── Watermark controls
        document.getElementById('mog-wm-show').addEventListener('change', function() {
            _wm.style.display = this.checked ? 'block' : 'none';
        });
        document.getElementById('mog-wm-alpha').addEventListener('input', function() {
            CONFIG.wmAlpha = parseInt(this.value);
            document.getElementById('mog-wm-alpha-val').textContent = this.value + '%';
            applyWmStyle();
        });
        document.getElementById('mog-wm-size').addEventListener('input', function() {
            CONFIG.wmFontSize = parseInt(this.value);
            document.getElementById('mog-wm-size-val').textContent = this.value + 'px';
            applyWmStyle();
        });
        document.getElementById('mog-wm-padding').addEventListener('input', function() {
            CONFIG.wmPaddingH = parseInt(this.value);
            CONFIG.wmPaddingV = Math.max(2, Math.round(parseInt(this.value) * 0.43));
            document.getElementById('mog-wm-padding-val').textContent = this.value + 'px';
            applyWmStyle();
        });
        document.getElementById('mog-wm-bg').addEventListener('change', function() {
            CONFIG.wmBg = this.checked;
            applyWmStyle();
        });
        document.getElementById('mog-wm-border').addEventListener('change', function() {
            CONFIG.wmBorder = this.checked;
            applyWmStyle();
        });
        document.getElementById('mog-menukey-clear').addEventListener('click', function() {
            _menuKey = null;
            menuKeyInput.value = '';
            menuKeyInput.style.borderColor = 'rgba(255,255,255,0.12)';
            menuKeyInput.style.color = '#c4b5fd';
        });

        // ── Score preview updater
        function updateScorePreview() {
            let score;
            if (CONFIG.finalScoreMode === 'range') {
                score = Math.round(CONFIG.finalScoreRangeMin + Math.random() * (CONFIG.finalScoreRangeMax - CONFIG.finalScoreRangeMin)) / 10000;
            } else {
                score = parseInt(CONFIG.myFinalScore) / 10000;
            }
            const tier = getTierForScore(score);
            const numEl = document.getElementById('mog-score-preview-num');
            const tierEl = document.getElementById('mog-score-preview-tier');
            numEl.textContent = score.toFixed(1);
            numEl.style.color = tier.hexColor;
            numEl.style.textShadow = tier.textShadow;
            tierEl.textContent = `${tier.emoji} ${tier.name}`;
            tierEl.style.color = tier.hexColor;
            tierEl.style.textShadow = tier.textShadow;
        }
        updateScorePreview();

        // ── Sync all slider display values on init
        document.getElementById('mog-final-score-val').textContent = (parseInt(CONFIG.myFinalScore) / 10000).toFixed(1);
        document.getElementById('mog-opp-score-val').textContent = (parseInt(CONFIG.oppFinalScore) / 10000).toFixed(2);
        document.getElementById('mog-boost-val').textContent = CONFIG.myScoreBoost.toFixed(2) + 'x';
        document.getElementById('mog-cap-val').textContent = (CONFIG.frameCap / 10000).toFixed(1);
        document.getElementById('mog-holdpct-val').textContent = '+' + CONFIG.boostPercent + '%';
        document.getElementById('mog-holdrand-val').textContent = '±' + CONFIG.boostRandom + '%';
        document.getElementById('mog-holddur-val').textContent = CONFIG.boostDuration + 'ms';

        // ── Hold tab sliders

        // ── Live status updater (runs every 200ms)
        setInterval(() => {
            // Mode badge
            const modeBadge = document.getElementById('mog-mode-badge');
            if (modeBadge) {
                modeBadge.textContent = _isRanked ? 'RANKED' : 'NORMAL';
                modeBadge.style.color = _isRanked ? '#d8b4fe' : '#93c5fd';
            }

            // Live score display
            // Hold multiplier status
            const multEl = document.getElementById('mog-hold-mult');
            if (multEl) multEl.textContent = _boostMultiplier.toFixed(3) + 'x';

            // Live score display
            if (_lastSpoofedScore !== null) {
                const tier = getTierForScore(_lastSpoofedScore);
                const liveScore = document.getElementById('mog-live-score');
                const liveTier = document.getElementById('mog-live-tier');
                if (liveScore) {
                    liveScore.textContent = _lastSpoofedScore.toFixed(2);
                    liveScore.style.color = tier.hexColor;
                    liveScore.style.textShadow = tier.textShadow;
                }
                if (liveTier) {
                    liveTier.textContent = `${tier.emoji} ${tier.name}`;
                    liveTier.style.color = tier.hexColor;
                }
            }
        }, 200);

        // ── Patch lastFinalize and lastFrame display — hook into existing log
        window._mogUpdateDebug = function(type, text) {
            // debug panel removed — no-op
        };

        // ── Camera spoof ──────────────────────────────────────────────────────
        let _camSpoofActive = false;
        let _camSrcType = 'video';
        let _origAddTrack = null;
        let _camSrcObjPatch = null;

        // Track all RTCPeerConnections so we can replaceTrack on them
        window._mogPCs = window._mogPCs || [];
        const _OrigPC2 = window.RTCPeerConnection;
        window.RTCPeerConnection = function(...args) {
            const pc = new _OrigPC2(...args);
            window._mogPCs.push(pc);
            pc.addEventListener('connectionstatechange', () => {
                if (pc.connectionState === 'closed') {
                    const idx = window._mogPCs.indexOf(pc);
                    if (idx > -1) window._mogPCs.splice(idx, 1);
                }
            });
            return pc;
        };
        Object.setPrototypeOf(window.RTCPeerConnection, _OrigPC2);
        window.RTCPeerConnection.prototype = _OrigPC2.prototype;
        let _camVideoFile = null;
        let _camImageFile = null;
        let _camMirror = false;
        let _camLoop = true;
        let _camSpeed = 1.0;
        let _camStream = null;
        let _camVideoEl = null;
        let _camCanvasEl = null;
        let _origGetUserMedia = null;

        // Source type toggle
        document.querySelectorAll('.mog-src-btn').forEach(b => {
            b.addEventListener('click', function() {
                _camSrcType = this.dataset.src;
                document.querySelectorAll('.mog-src-btn').forEach(x => {
                    const on = x.dataset.src === _camSrcType;
                    x.style.background = on ? 'rgba(var(--mog-accent-rgb),0.15)' : 'rgba(255,255,255,0.04)';
                    x.style.color = on ? 'var(--mog-accent)' : 'rgba(255,255,255,0.4)';
                    x.style.borderColor = on ? 'rgba(var(--mog-accent-rgb),0.4)' : 'rgba(255,255,255,0.1)';
                });
                const vs = document.getElementById('mog-src-video-section');
                const is = document.getElementById('mog-src-image-section');
                if (_camSrcType === 'video') {
                    vs.style.display = 'flex'; is.style.display = 'none';
                } else {
                    vs.style.display = 'none'; is.style.display = 'flex';
                }
            });
        });

        // File pickers
        document.getElementById('mog-video-pick-btn').addEventListener('click', () => {
            document.getElementById('mog-video-input').click();
        });
        document.getElementById('mog-video-input').addEventListener('change', function() {
            if (this.files[0]) {
                _camVideoFile = this.files[0];
                const nameEl = document.getElementById('mog-video-name');
                const fn = this.files[0].name;
                nameEl.textContent = fn.slice(0, 5) + (fn.length > 5 ? '...' : '');
                nameEl.style.color = '#86efac';
            }
        });
        document.getElementById('mog-image-pick-btn').addEventListener('click', () => {
            document.getElementById('mog-image-input').click();
        });
        document.getElementById('mog-image-input').addEventListener('change', function() {
            if (this.files[0]) {
                _camImageFile = this.files[0];
                const nameEl = document.getElementById('mog-image-name');
                nameEl.textContent = this.files[0].name;
                nameEl.style.color = '#86efac';
            }
        });

        // Options
        document.getElementById('mog-camloop-toggle').addEventListener('change', function() {
            _camLoop = this.checked;
            if (_camVideoEl) _camVideoEl.loop = _camLoop;
        });
        document.getElementById('mog-camspeed').addEventListener('input', function() {
            _camSpeed = parseFloat(this.value);
            document.getElementById('mog-camspeed-val').textContent = _camSpeed.toFixed(2) + 'x';
            if (_camVideoEl) _camVideoEl.playbackRate = _camSpeed;
        });
        document.getElementById('mog-cammirror-toggle').addEventListener('change', function() {
            _camMirror = this.checked;
        });

        function setCamStatus(text, color) {
            const el = document.getElementById('mog-camstatus-text');
            if (el) { el.textContent = text; el.style.color = color || 'rgba(255,255,255,0.3)'; }
        }

        function buildFakeStream() {
            _camCanvasEl = document.createElement('canvas');
            _camCanvasEl.width = 640; _camCanvasEl.height = 480;
            const ctx = _camCanvasEl.getContext('2d');

            if (_camSrcType === 'video' && _camVideoFile) {
                _camVideoEl = document.createElement('video');
                _camVideoEl.src = URL.createObjectURL(_camVideoFile);
                _camVideoEl.loop = _camLoop;
                _camVideoEl.muted = true;
                _camVideoEl.playbackRate = _camSpeed;
                _camVideoEl.play().catch(() => {});

                function drawFrame() {
                    if (!_camSpoofActive) return;
                    ctx.save();
                    if (_camMirror) { ctx.translate(640, 0); ctx.scale(-1, 1); }
                    ctx.drawImage(_camVideoEl, 0, 0, 640, 480);
                    ctx.restore();
                    requestAnimationFrame(drawFrame);
                }
                _camVideoEl.addEventListener('canplay', () => { drawFrame(); }, { once: true });

            } else if (_camSrcType === 'image' && _camImageFile) {
                const img = new Image();
                img.src = URL.createObjectURL(_camImageFile);
                img.onload = () => {
                    function drawStatic() {
                        if (!_camSpoofActive) return;
                        ctx.save();
                        if (_camMirror) { ctx.translate(640, 0); ctx.scale(-1, 1); }
                        ctx.drawImage(img, 0, 0, 640, 480);
                        ctx.restore();
                        requestAnimationFrame(drawStatic);
                    }
                    drawStatic();
                };
            } else {
                setCamStatus('No file selected', '#fca5a5');
                return null;
            }

            return _camCanvasEl.captureStream(30);
        }

        function startCamSpoof() {
            const fakeStream = buildFakeStream();
            if (!fakeStream) return;
            _camStream = fakeStream;

            // ── Level 1: patch getUserMedia so the game gets our fake stream
            // from the start — affects scanner-video and LiveKit track
            if (!_origGetUserMedia) {
                _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            }
            navigator.mediaDevices.getUserMedia = async function(constraints) {
                if (constraints && (constraints.video || constraints.video === true)) {
                    setCamStatus('Active (getUserMedia)', '#86efac');
                    if (constraints.audio) {
                        try {
                            const realAudio = await _origGetUserMedia({ audio: constraints.audio });
                            return new MediaStream([
                                ..._camStream.getVideoTracks(),
                                ...realAudio.getAudioTracks()
                            ]);
                        } catch(e) {
                            return _camStream;
                        }
                    }
                    return _camStream;
                }
                return _origGetUserMedia(constraints);
            };

            // ── Level 2: if the game already has scanner-video running,
            // swap its srcObject directly right now
            const scannerVid = document.querySelector('video.scanner-video');
            if (scannerVid && scannerVid.srcObject) {
                console.log('🎥 Direct scanner-video swap');
                scannerVid.srcObject = _camStream;
                setCamStatus('Active (direct swap)', '#86efac');
            }

            // ── Level 3: intercept every future srcObject assignment on
            // scanner-video so if it restarts it still gets our stream
            const _srcObjDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
            _camSrcObjPatch = function(stream) {
                if (this.classList?.contains('scanner-video') && stream && _camSpoofActive) {
                    console.log('🎥 scanner-video srcObject intercepted — replacing with fake stream');
                    setCamStatus('Active (intercepted)', '#86efac');
                    _srcObjDesc.set.call(this, _camStream);
                    return;
                }
                _srcObjDesc.set.call(this, stream);
            };
            Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
                get() { return _srcObjDesc.get.call(this); },
                set: _camSrcObjPatch,
                configurable: true
            });

            // ── Level 4: patch RTCPeerConnection.addTrack so LiveKit sends
            // our fake video track instead of the real camera track
            if (!_origAddTrack) {
                _origAddTrack = RTCPeerConnection.prototype.addTrack;
                RTCPeerConnection.prototype.addTrack = function(track, ...streams) {
                    if (track.kind === 'video' && _camSpoofActive && _camStream) {
                        const fakeTrack = _camStream.getVideoTracks()[0];
                        if (fakeTrack) {
                            console.log('🎥 RTCPeerConnection.addTrack — swapping real video for fake');
                            setCamStatus('Active (LiveKit patched)', '#86efac');
                            return _origAddTrack.call(this, fakeTrack, ...streams);
                        }
                    }
                    return _origAddTrack.call(this, track, ...streams);
                };
            }

            // ── Level 5: for already-established LiveKit connections,
            // find any active RTCSenders and replace their track
            try {
                // LiveKit creates RTCPeerConnections — iterate all of them
                // by watching the prototype we already patched; but for any
                // existing senders we need to call replaceTrack directly
                const fakeTrack = _camStream.getVideoTracks()[0];
                if (fakeTrack && window._mogPCs) {
                    for (const pc of window._mogPCs) {
                        pc.getSenders().forEach(sender => {
                            if (sender.track?.kind === 'video') {
                                sender.replaceTrack(fakeTrack).then(() => {
                                    console.log('🎥 replaceTrack success on existing sender');
                                    setCamStatus('Active (replaceTrack)', '#86efac');
                                }).catch(e => console.warn('replaceTrack failed:', e));
                            }
                        });
                    }
                }
            } catch(e) {}
        }

        function stopCamSpoof() {
            // Restore getUserMedia first, save ref before nulling
            const savedGetUserMedia = _origGetUserMedia;
            if (_origGetUserMedia) {
                navigator.mediaDevices.getUserMedia = _origGetUserMedia;
                _origGetUserMedia = null;
            }
            // Restore srcObject interception
            if (_camSrcObjPatch) {
                const _srcObjDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
                Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
                    get() { return _srcObjDesc.get.call(this); },
                    set(v) { _srcObjDesc.set.call(this, v); },
                    configurable: true
                });
                _camSrcObjPatch = null;
            }
            // Restore addTrack
            if (_origAddTrack) {
                RTCPeerConnection.prototype.addTrack = _origAddTrack;
                _origAddTrack = null;
            }
            if (_camVideoEl) { _camVideoEl.pause(); _camVideoEl = null; }
            if (_camStream) { _camStream.getTracks().forEach(t => t.stop()); _camStream = null; }
            _camSpoofActive = false;

            // Give real camera back to scanner-video and all senders
            const base = savedGetUserMedia || navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            base({ video: true }).then(realStream => {
                const realTrack = realStream.getVideoTracks()[0];
                // Restore scanner-video
                const scannerVid = document.querySelector('video.scanner-video');
                if (scannerVid) scannerVid.srcObject = realStream;
                // Restore peer connection senders
                if (realTrack && window._mogPCs) {
                    for (const pc of window._mogPCs) {
                        pc.getSenders().forEach(sender => {
                            if (sender.track?.kind === 'video') {
                                sender.replaceTrack(realTrack).catch(() => {});
                            }
                        });
                    }
                }
            }).catch(() => {});

            setCamStatus('Inactive', 'rgba(255,255,255,0.3)');
        }

        // ── PARTICLE ENGINE ───────────────────────────────────────────────────
        const _particleCfg = {
            active: false,
            count: 80,
            size: 5,
            speed: 1.0,
            drift: 0.5,
            opacity: 70,
            color: '#ffffff',
            rainbow: false,
            shape: 'circle',
            glow: true,
            wobble: true
        };
        let _particleCanvas = null;
        let _particleCtx = null;
        let _particleRAF = null;
        let _particles = [];

        function _makeParticle() {
            return {
                x: Math.random() * window.innerWidth,
                y: -20 - Math.random() * window.innerHeight,
                r: (_particleCfg.size * 0.5) + Math.random() * _particleCfg.size * 0.8,
                vy: (1.0 + Math.random() * 1.5) * _particleCfg.speed,
                vx: (Math.random() - 0.5) * _particleCfg.drift,
                wobblePhase: Math.random() * Math.PI * 2,
                wobbleSpeed: 0.01 + Math.random() * 0.03,
                wobbleAmp: 0.5 + Math.random() * 2.0,
                hue: Math.random() * 360,
                alpha: 0.3 + Math.random() * 0.7
            };
        }

        function _drawShape(ctx, p, color) {
            const s = p.r;
            ctx.fillStyle = color;
            ctx.strokeStyle = color;
            if (_particleCfg.glow) {
                ctx.shadowColor = color;
                ctx.shadowBlur = s * 2.5;
            } else {
                ctx.shadowBlur = 0;
            }
            ctx.beginPath();
            switch (_particleCfg.shape) {
                case 'circle':
                    ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
                    ctx.fill();
                    break;
                case 'square':
                    ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
                    break;
                case 'star': {
                    const spikes = 5, outer = s, inner = s * 0.45;
                    let rot = (Math.PI / 2) * 3;
                    const step = Math.PI / spikes;
                    ctx.moveTo(p.x, p.y - outer);
                    for (let i = 0; i < spikes; i++) {
                        ctx.lineTo(p.x + Math.cos(rot) * outer, p.y + Math.sin(rot) * outer); rot += step;
                        ctx.lineTo(p.x + Math.cos(rot) * inner, p.y + Math.sin(rot) * inner); rot += step;
                    }
                    ctx.lineTo(p.x, p.y - outer);
                    ctx.fill();
                    break;
                }
                case 'heart': {
                    const hs = s * 0.9;
                    ctx.moveTo(p.x, p.y + hs * 0.6);
                    ctx.bezierCurveTo(p.x - hs * 1.2, p.y - hs * 0.4, p.x - hs * 2.2, p.y + hs * 0.6, p.x, p.y + hs * 1.8);
                    ctx.bezierCurveTo(p.x + hs * 2.2, p.y + hs * 0.6, p.x + hs * 1.2, p.y - hs * 0.4, p.x, p.y + hs * 0.6);
                    ctx.fill();
                    break;
                }
            }
        }

        function _particleLoop() {
            if (!_particleCfg.active) return;
            const W = window.innerWidth, H = window.innerHeight;
            if (_particleCanvas.width !== W) _particleCanvas.width = W;
            if (_particleCanvas.height !== H) _particleCanvas.height = H;
            _particleCtx.clearRect(0, 0, W, H);

            // ensure count matches
            while (_particles.length < _particleCfg.count) _particles.push(_makeParticle());
            while (_particles.length > _particleCfg.count) _particles.pop();

            for (const p of _particles) {
                p.wobblePhase += p.wobbleSpeed;
                if (_particleCfg.wobble) p.x += Math.sin(p.wobblePhase) * p.wobbleAmp;
                p.x += p.vx;
                p.y += p.vy;
                if (p.y > H + 30) {
                    p.y = -20; p.x = Math.random() * W;
                    p.vx = (Math.random() - 0.5) * _particleCfg.drift;
                    p.hue = Math.random() * 360;
                }
                const baseAlpha = (_particleCfg.opacity / 100) * p.alpha;
                let color;
                if (_particleCfg.rainbow) {
                    color = `hsla(${p.hue},100%,70%,${baseAlpha})`;
                    p.hue = (p.hue + 0.3) % 360;
                } else {
                    const hex = _particleCfg.color;
                    const r = parseInt(hex.slice(1,3),16);
                    const g = parseInt(hex.slice(3,5),16);
                    const b = parseInt(hex.slice(5,7),16);
                    color = `rgba(${r},${g},${b},${baseAlpha})`;
                }
                _particleCtx.globalAlpha = 1;
                _drawShape(_particleCtx, p, color);
            }
            _particleRAF = requestAnimationFrame(_particleLoop);
        }

        function startParticles() {
            if (_particleCanvas) { stopParticles(); }
            _particleCanvas = document.createElement('canvas');
            _particleCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:999990;';
            document.body.appendChild(_particleCanvas);
            _particleCtx = _particleCanvas.getContext('2d');
            _particles = Array.from({ length: _particleCfg.count }, _makeParticle);
            // spread vertically so they don't all arrive at once
            _particles.forEach((p, i) => { p.y = Math.random() * window.innerHeight; });
            _particleCfg.active = true;
            _particleLoop();
        }

        function stopParticles() {
            _particleCfg.active = false;
            if (_particleRAF) { cancelAnimationFrame(_particleRAF); _particleRAF = null; }
            if (_particleCanvas) { _particleCanvas.remove(); _particleCanvas = null; _particleCtx = null; }
            _particles = [];
        }

        // Wire up particle controls
        document.getElementById('mog-particles-toggle').addEventListener('change', function() {
            if (this.checked) startParticles(); else stopParticles();
        });
        document.getElementById('mog-particles-count').addEventListener('input', function() {
            _particleCfg.count = parseInt(this.value);
            document.getElementById('mog-particles-count-val').textContent = this.value;
        });
        document.getElementById('mog-particles-size').addEventListener('input', function() {
            _particleCfg.size = parseInt(this.value);
            document.getElementById('mog-particles-size-val').textContent = this.value + 'px';
        });
        document.getElementById('mog-particles-speed').addEventListener('input', function() {
            _particleCfg.speed = parseFloat(this.value);
            document.getElementById('mog-particles-speed-val').textContent = parseFloat(this.value).toFixed(1) + 'x';
            // Update existing particles' velocity to reflect new speed immediately
            _particles.forEach(p => {
                p.vy = (1.0 + Math.random() * 1.5) * _particleCfg.speed;
            });
        });
        document.getElementById('mog-particles-drift').addEventListener('input', function() {
            _particleCfg.drift = parseFloat(this.value);
            document.getElementById('mog-particles-drift-val').textContent = parseFloat(this.value).toFixed(1);
        });
        document.getElementById('mog-particles-opacity').addEventListener('input', function() {
            _particleCfg.opacity = parseInt(this.value);
            document.getElementById('mog-particles-opacity-val').textContent = this.value + '%';
        });
        document.getElementById('mog-particles-color').addEventListener('input', function() {
            _particleCfg.color = this.value;
        });
        document.getElementById('mog-particles-rainbow').addEventListener('change', function() {
            _particleCfg.rainbow = this.checked;
        });
        document.getElementById('mog-particles-glow').addEventListener('change', function() {
            _particleCfg.glow = this.checked;
        });
        document.getElementById('mog-particles-wobble').addEventListener('change', function() {
            _particleCfg.wobble = this.checked;
        });
        document.querySelectorAll('.mog-shape-btn').forEach(b => {
            b.addEventListener('click', function() {
                _particleCfg.shape = this.dataset.shape;
                document.querySelectorAll('.mog-shape-btn').forEach(x => {
                    const on = x.dataset.shape === _particleCfg.shape;
                    x.style.background = on ? 'rgba(var(--mog-accent-rgb),0.15)' : 'rgba(255,255,255,0.04)';
                    x.style.color = on ? 'var(--mog-accent)' : 'rgba(255,255,255,0.4)';
                    x.style.borderColor = on ? 'rgba(var(--mog-accent-rgb),0.4)' : 'rgba(255,255,255,0.1)';
                });
            });
        });

        // ── OVERLAY IMAGES (ban + loading) ────────────────────────────────────
        const OVERLAY_URLS = {
            ban:     'https://raw.githubusercontent.com/sevkabevka/sevkabevka.github.io/main/ChatGPT%20Image%2023%20%D0%BC%D0%B0%D1%8F%202026%20%D0%B3.,%2019_13_02.png',
            loading: 'https://raw.githubusercontent.com/sevkabevka/sevkabevka.github.io/main/ChatGPT%20Image%2023%20%D0%BC%D0%B0%D1%8F%202026%20%D0%B3.,%2017_59_13_Nero_AI_Image_Upscaler_Photo_Face.png'
        };

        let _overlayActive = null; // 'ban' | 'loading' | null
        let _overlayImg = { ban: null, loading: null };
        let _overlayCanvas = null;
        let _overlayStream = null;
        let _overlayRAF = null;

        // Preload both images immediately
        ['ban', 'loading'].forEach(key => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = OVERLAY_URLS[key];
            img.onload = () => { _overlayImg[key] = img; console.log(`🖼 Overlay [${key}] loaded`); };
            img.onerror = () => console.warn(`⚠️ Overlay [${key}] failed to load`);
        });

        function setOverlayStatus(text, color) {
            const el = document.getElementById('mog-overlay-status-text');
            if (el) { el.textContent = text; el.style.color = color || 'rgba(255,255,255,0.3)'; }
        }

        function buildOverlayStream(key) {
            const img = _overlayImg[key];
            if (!img) {
                setOverlayStatus(`${key} image not loaded yet`, '#fca5a5');
                return null;
            }
            _overlayCanvas = document.createElement('canvas');
            _overlayCanvas.width = 640;
            _overlayCanvas.height = 480;
            const ctx = _overlayCanvas.getContext('2d');

            function drawOverlay() {
                if (!_overlayActive) return;
                ctx.save();
                ctx.translate(640, 0);
                ctx.scale(-1, 1);
                ctx.drawImage(img, 0, 0, 640, 480);
                ctx.restore();
                _overlayRAF = requestAnimationFrame(drawOverlay);
            }
            drawOverlay();
            return _overlayCanvas.captureStream(30);
        }

        function _pushTrackToAll(stream) {
            const track = stream ? stream.getVideoTracks()[0] : null;
            if (!track) return;
            // scanner-video
            const scannerVid = document.querySelector('video.scanner-video');
            if (scannerVid) scannerVid.srcObject = stream;
            // all active peer connection senders
            if (window._mogPCs) {
                for (const pc of window._mogPCs) {
                    try {
                        pc.getSenders().forEach(sender => {
                            if (sender.track?.kind === 'video') {
                                sender.replaceTrack(track).catch(() => {});
                            }
                        });
                    } catch(e) {}
                }
            }
        }

        function startOverlay(key) {
            // fully tear down any existing overlay first, never skip restoreCam
            if (_overlayRAF) { cancelAnimationFrame(_overlayRAF); _overlayRAF = null; }
            if (_overlayStream) { _overlayStream.getTracks().forEach(t => t.stop()); _overlayStream = null; }
            _overlayCanvas = null;
            _overlayActive = null;

            const img = _overlayImg[key];
            if (!img) {
                setOverlayStatus(`${key} image not loaded yet — try again`, '#fca5a5');
                return;
            }

            _overlayActive = key;
            _overlayCanvas = document.createElement('canvas');
            _overlayCanvas.width = 640; _overlayCanvas.height = 480;
            const ctx = _overlayCanvas.getContext('2d');

            function drawOverlay() {
                if (!_overlayActive) return;
                ctx.save();
                ctx.translate(640, 0);
                ctx.scale(-1, 1);
                ctx.drawImage(img, 0, 0, 640, 480);
                ctx.restore();
                _overlayRAF = requestAnimationFrame(drawOverlay);
            }
            drawOverlay();

            _overlayStream = _overlayCanvas.captureStream(30);
            _pushTrackToAll(_overlayStream);
            setOverlayStatus(`${key.toUpperCase()} active`, key === 'ban' ? '#fca5a5' : '#93c5fd');
        }

        function stopOverlay() {
            if (_overlayRAF) { cancelAnimationFrame(_overlayRAF); _overlayRAF = null; }
            if (_overlayStream) { _overlayStream.getTracks().forEach(t => t.stop()); _overlayStream = null; }
            _overlayActive = null;
            _overlayCanvas = null;

            // Always restore — cam spoof stream if active, otherwise real camera
            if (_camSpoofActive && _camStream) {
                _pushTrackToAll(_camStream);
            } else {
                // restore real camera to senders
                const base = _origGetUserMedia || navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
                base({ video: true }).then(realStream => {
                    _pushTrackToAll(realStream);
                }).catch(() => {});
            }
            setOverlayStatus('None active', 'rgba(255,255,255,0.3)');
        }

        document.getElementById('mog-ban-overlay-toggle').addEventListener('change', function() {
            document.getElementById('mog-loading-overlay-toggle').checked = false;
            if (this.checked) {
                startOverlay('ban');
            } else {
                stopOverlay();
            }
        });

        document.getElementById('mog-loading-overlay-toggle').addEventListener('change', function() {
            document.getElementById('mog-ban-overlay-toggle').checked = false;
            if (this.checked) {
                startOverlay('loading');
            } else {
                stopOverlay();
            }
        });

        document.getElementById('mog-camspoof-toggle').addEventListener('change', function() {
            _camSpoofActive = this.checked;
            if (_camSpoofActive) {
                startCamSpoof();
            } else {
                stopCamSpoof();
            }
        });
    }

    // Expose Zustand patch status to menu
    const _origPatchStore = patchStore;
    // Mark zustand as patched in UI once it succeeds
    const _zustandInterval = setInterval(() => {
        const badge = document.getElementById('mog-zustand-badge');
        if (!badge) return;
        try {
            const wpChunk = window.webpackChunk_N_E || window.webpackChunknextjs_app || window.webpackChunk;
            if (!wpChunk) return;
            const req = wpChunk.push([[Symbol()], {}, e => e]);
            const mod = req(16225);
            const store = mod && Object.values(mod).find(v => v && typeof v.getState === 'function' && 'myScore' in (v.getState() || {}));
            if (store && store.getState().setMyScore?.__patched) {
                badge.textContent = 'PATCHED';
                badge.style.color = '#86efac';
                clearInterval(_zustandInterval);
            }
        } catch(e) {}
    }, 500);

    // Hook frame log to debug tab
    const _realLog = log;
    function log(...args) {
        if (CONFIG.debug) console.log('[Omoggle]', ...args);
        const msg = args.join(' ');
        if (msg.includes('📤') && msg.includes('frame=') && window._mogUpdateDebug) {
            window._mogUpdateDebug('frame', msg);
        }
        if (msg.includes('FINALIZE') && msg.includes('modified') && window._mogUpdateDebug) {
            window._mogUpdateDebug('finalize', msg.slice(0, 300));
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildMenu);
    } else {
        buildMenu();
    }

})();