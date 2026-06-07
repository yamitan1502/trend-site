import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── Steam: ゲーム名からSteamページを検索 ──────────────────
async function getSteamUrl(gameName) {
  try {
    const res = await fetch(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=japanese&cc=JP`
    );
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      const appId = data.items[0].id;
      return `https://store.steampowered.com/app/${appId}/`;
    }
  } catch (e) {
    console.error('Steam API error:', e.message);
  }
  return null;
}

// ─── ブラウザゲーム判定 ────────────────────────────────────
const BROWSER_GAMES = {
  'among us':        'https://www.innersloth.com/games/among-us/',
  'skribbl':         'https://skribbl.io/',
  'gartic phone':    'https://garticphone.com/',
  'wordle':          'https://www.nytimes.com/games/wordle/index.html',
  'krunker':         'https://krunker.io/',
  'slither.io':      'https://slither.io/',
  'agar.io':         'https://agar.io/',
  'diep.io':         'https://diep.io/',
  'surviv.io':       'https://surviv.io/',
  'little big snake':'https://littlebigsnake.com/',
};

function getBrowserGameUrl(gameName) {
  const lower = gameName.toLowerCase();
  for (const [key, url] of Object.entries(BROWSER_GAMES)) {
    if (lower.includes(key)) return url;
  }
  if (/\.io$/.test(lower)) return `https://${lower}`;
  return null;
}

// ─── ゲームURLを解決（ブラウザゲーム優先、次にSteam）──────
async function resolveGameUrl(gameName) {
  const browserUrl = getBrowserGameUrl(gameName);
  if (browserUrl) return { url: browserUrl, genre: 'ブラウザゲーム' };

  const steamUrl = await getSteamUrl(gameName);
  if (steamUrl) return { url: steamUrl, genre: 'Steamゲーム' };

  return { url: null, genre: 'ゲーム' };
}

// ─── YouTube: ゲームカテゴリの動画を取得 ──────────────────
async function fetchYouTube() {
  console.log('Fetching YouTube trends...');

  // videoCategoryId=20 はYouTubeのゲームカテゴリ
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=JP&videoCategoryId=20&maxResults=20&key=${process.env.YOUTUBE_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.items) {
    console.error('YouTube API error:', data);
    return;
  }

  // ゲーム名を抽出してまとめる
  const gameMap = new Map();

  for (const item of data.items) {
    const gameName = item.snippet.tags?.[0]
      || extractGameName(item.snippet.title)
      || item.snippet.title;

    if (!gameName) continue;
    const key = gameName.toLowerCase();

    if (!gameMap.has(key)) {
      gameMap.set(key, {
        name: gameName,
        views: parseInt(item.statistics.viewCount || 0),
        count: 1,
      });
    } else {
      const existing = gameMap.get(key);
      existing.views += parseInt(item.statistics.viewCount || 0);
      existing.count += 1;
    }
  }

  const rows = [];
  for (const [, game] of gameMap) {
    const { url, genre } = await resolveGameUrl(game.name);
    rows.push({
      platform:    'YouTube',
      genre,
      title:       game.name,
      description: `${game.count}本の動画でトレンド入り • 総再生数 ${game.views.toLocaleString()}回`,
      url,
      heat:        calcHeat(game.views, [500000, 5000000]),
      source_id:   `yt_game_${game.name.toLowerCase().replace(/\s+/g, '_')}`,
      expires_at:  new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });
  }

  await upsertTrends(rows);
  console.log(`YouTube: ${rows.length}件保存`);
}

// 動画タイトルからゲーム名を抽出
function extractGameName(title) {
  // 「【ゲーム名】」や「'ゲーム名'」のパターンを抽出
  const patterns = [
    /【(.+?)】/,
    /「(.+?)」/,
    /『(.+?)』/,
    /\[(.+?)\]/,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ─── Twitch: 人気ゲームを取得 ──────────────────────────────
async function fetchTwitch() {
  console.log('Fetching Twitch trends...');

  const tokenRes = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const tokenData = await tokenRes.json();
  const token = tokenData.access_token;

  // トップゲームを取得
  const res = await fetch('https://api.twitch.tv/helix/games/top?first=20', {
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
    }
  });
  const data = await res.json();

  if (!data.data) {
    console.error('Twitch API error:', data);
    return;
  }

  // 各ゲームの視聴者数を取得
  const gameIds = data.data.map(g => `game_id=${g.id}`).join('&');
  const streamsRes = await fetch(
    `https://api.twitch.tv/helix/streams?${gameIds}&first=100`,
    {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
      }
    }
  );
  const streamsData = await streamsRes.json();

  // ゲームごとに視聴者数を集計
  const viewerMap = new Map();
  for (const stream of streamsData.data || []) {
    const id = stream.game_id;
    viewerMap.set(id, (viewerMap.get(id) || 0) + stream.viewer_count);
  }

  const rows = [];
  for (const game of data.data) {
    const totalViewers = viewerMap.get(game.id) || 0;
    const { url, genre } = await resolveGameUrl(game.name);

    rows.push({
      platform:    'Twitch',
      genre,
      title:       game.name,
      description: `視聴者数 ${totalViewers.toLocaleString()}人がライブ視聴中`,
      url,
      heat:        calcHeat(totalViewers, [10000, 100000]),
      source_id:   `tw_game_${game.name.toLowerCase().replace(/\s+/g, '_')}`,
      expires_at:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  await upsertTrends(rows);
  console.log(`Twitch: ${rows.length}件保存`);
}

// ─── 注目度スコア ──────────────────────────────────────────
function calcHeat(value, thresholds) {
  if (value >= thresholds[1]) return 3;
  if (value >= thresholds[0]) return 2;
  return 1;
}

// ─── Supabaseへ保存 ────────────────────────────────────────
async function upsertTrends(rows) {
  const { error } = await supabase
    .from('trends')
    .upsert(rows, { onConflict: 'source_id' });

  if (error) console.error('Supabase upsert error:', error);
}

// ─── メイン ────────────────────────────────────────────────
async function main() {
  await Promise.all([
    fetchYouTube(),
    fetchTwitch(),
  ]);
  console.log('完了！');
}

main().catch(console.error);
