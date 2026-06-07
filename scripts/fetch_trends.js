import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import googleTrends from 'google-trends-api';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── Steam URLを取得 ───────────────────────────────────────
async function getSteamUrl(gameName) {
  try {
    const res = await fetch(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=japanese&cc=JP`
    );
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      return `https://store.steampowered.com/app/${data.items[0].id}/`;
    }
  } catch (e) {
    console.error('Steam API error:', e.message);
  }
  return null;
}

// ─── ブラウザゲーム判定 ────────────────────────────────────
const BROWSER_GAMES = {
  'among us':         'https://www.innersloth.com/games/among-us/',
  'skribbl':          'https://skribbl.io/',
  'gartic phone':     'https://garticphone.com/',
  'wordle':           'https://www.nytimes.com/games/wordle/index.html',
  'krunker':          'https://krunker.io/',
  'slither.io':       'https://slither.io/',
  'agar.io':          'https://agar.io/',
  'diep.io':          'https://diep.io/',
};

function getBrowserGameUrl(gameName) {
  const lower = gameName.toLowerCase();
  for (const [key, url] of Object.entries(BROWSER_GAMES)) {
    if (lower.includes(key)) return url;
  }
  if (/\.io$/.test(lower)) return `https://${lower}`;
  return null;
}

async function resolveGameUrl(gameName) {
  const browserUrl = getBrowserGameUrl(gameName);
  if (browserUrl) return { url: browserUrl, genre: 'ブラウザゲーム' };
  const steamUrl = await getSteamUrl(gameName);
  if (steamUrl) return { url: steamUrl, genre: 'Steamゲーム' };
  return { url: null, genre: 'ゲーム' };
}

// ─── A. Google Trends 急上昇ワードを取得 ──────────────────
async function fetchGoogleTrends() {
  console.log('Fetching Google Trends...');
  try {
    const result = await googleTrends.dailyTrends({
      trendDate: new Date(),
      geo: 'JP',
    });

    const data = JSON.parse(result);
    const trendingSearches = data.default.trendingSearchesDays[0].trendingSearches;

    const rows = [];
    for (const trend of trendingSearches.slice(0, 20)) {
      const keyword = trend.title.query;
      const traffic = trend.formattedTraffic; // 例: "200K+"

      // ゲーム関連キーワードかどうか判定
      const isGame = isGameKeyword(keyword, trend.articles || []);

      const { url, genre } = isGame
        ? await resolveGameUrl(keyword)
        : { url: `https://trends.google.co.jp/trends/explore?q=${encodeURIComponent(keyword)}&geo=JP`, genre: 'トレンド' };

      rows.push({
        platform:    'Google',
        genre,
        title:       keyword,
        description: `急上昇ワード • 検索数 ${traffic}`,
        url,
        heat:        calcHeatFromTraffic(traffic),
        source_id:   `gt_${keyword.toLowerCase().replace(/\s+/g, '_')}`,
        expires_at:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
    }

    await upsertTrends(rows);
    console.log(`Google Trends: ${rows.length}件保存`);
  } catch (e) {
    console.error('Google Trends error:', e.message);
  }
}

// ゲーム関連キーワード判定
function isGameKeyword(keyword, articles) {
  const gameWords = ['ゲーム', 'game', 'steam', 'nintendo', '任天堂', 'xbox', 'playstation', 'ps5', 'switch', 'minecraft', 'fortnite', 'apex', 'valorant', 'pokemon', 'ポケモン'];
  const lower = keyword.toLowerCase();
  if (gameWords.some(w => lower.includes(w))) return true;
  const articleText = articles.map(a => (a.title || '') + (a.snippet || '')).join(' ').toLowerCase();
  if (gameWords.some(w => articleText.includes(w))) return true;
  return false;
}

// Google Trendsのトラフィック文字列からheatを計算
function calcHeatFromTraffic(traffic) {
  const num = parseInt(traffic.replace(/[^0-9]/g, ''));
  if (traffic.includes('M') || num >= 500) return 3;
  if (num >= 100) return 2;
  return 1;
}

// ─── C. Twitchランキング変化から急上昇ゲームを取得 ────────
async function fetchTwitchRising() {
  console.log('Fetching Twitch rising games...');

  const tokenRes = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const { access_token: token } = await tokenRes.json();

  // 現在のトップゲームを取得
  const res = await fetch('https://api.twitch.tv/helix/games/top?first=50', {
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
    }
  });
  const { data: currentGames } = await res.json();

  if (!currentGames) return;

  // 視聴者数を取得
  const gameIds = currentGames.map(g => `game_id=${g.id}`).join('&');
  const streamsRes = await fetch(
    `https://api.twitch.tv/helix/streams?${gameIds}&first=100`,
    { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } }
  );
  const { data: streams } = await streamsRes.json();

  const viewerMap = new Map();
  for (const s of streams || []) {
    viewerMap.set(s.game_id, (viewerMap.get(s.game_id) || 0) + s.viewer_count);
  }

  // 現在のランキングをSupabaseに保存
  const historyRows = currentGames.map((g, i) => ({
    game_id:   g.id,
    game_name: g.name,
    rank:      i + 1,
    viewers:   viewerMap.get(g.id) || 0,
  }));

  await supabase.from('twitch_game_history').insert(historyRows);

  // 2週間前のランキングを取得
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const oneWeekAgo  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();

  const { data: oldRankings } = await supabase
    .from('twitch_game_history')
    .select('game_id, rank, viewers')
    .gte('recorded_at', twoWeeksAgo)
    .lte('recorded_at', oneWeekAgo)
    .order('recorded_at', { ascending: false });

  // 古いランキングの平均を計算
  const oldRankMap = new Map();
  if (oldRankings && oldRankings.length > 0) {
    const countMap = new Map();
    for (const r of oldRankings) {
      if (!oldRankMap.has(r.game_id)) {
        oldRankMap.set(r.game_id, 0);
        countMap.set(r.game_id, 0);
      }
      oldRankMap.set(r.game_id, oldRankMap.get(r.game_id) + r.rank);
      countMap.set(r.game_id, countMap.get(r.game_id) + 1);
    }
    for (const [id, total] of oldRankMap) {
      oldRankMap.set(id, total / countMap.get(id));
    }
  }

  // 急上昇ゲームを抽出
  const risingGames = [];
  for (const game of currentGames) {
    const currentRank = currentGames.findIndex(g => g.id === game.id) + 1;
    const oldRank = oldRankMap.get(game.id);
    const viewers = viewerMap.get(game.id) || 0;

    if (!oldRank) {
      // 2週間前に存在しなかった = 新規急上昇
      risingGames.push({ game, currentRank, improvement: 999, viewers, isNew: true });
    } else if (oldRank - currentRank >= 5) {
      // 5位以上ランクアップ = 急上昇
      risingGames.push({ game, currentRank, improvement: oldRank - currentRank, viewers, isNew: false });
    }
  }

  // 急上昇ゲームがない場合（データ蓄積前）はトップ20を表示
  const targetGames = risingGames.length > 0
    ? risingGames.slice(0, 20)
    : currentGames.slice(0, 20).map((game, i) => ({
        game, currentRank: i + 1, improvement: 0, viewers: viewerMap.get(game.id) || 0, isNew: false
      }));

  const rows = [];
  for (const { game, currentRank, improvement, viewers, isNew } of targetGames) {
    const { url, genre } = await resolveGameUrl(game.name);
    const desc = isNew
      ? `新規ランクイン • 現在${currentRank}位 • 視聴者 ${viewers.toLocaleString()}人`
      : improvement >= 5
        ? `${Math.round(improvement)}位上昇 → 現在${currentRank}位 • 視聴者 ${viewers.toLocaleString()}人`
        : `現在${currentRank}位 • 視聴者 ${viewers.toLocaleString()}人`;

    rows.push({
      platform:    'Twitch',
      genre,
      title:       game.name,
      description: desc,
      url,
      heat:        calcHeat(viewers, [10000, 100000]),
      source_id:   `tw_rising_${game.id}`,
      expires_at:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  await upsertTrends(rows);
  console.log(`Twitch rising: ${rows.length}件保存`);
}

function calcHeat(value, thresholds) {
  if (value >= thresholds[1]) return 3;
  if (value >= thresholds[0]) return 2;
  return 1;
}

async function upsertTrends(rows) {
  const { error } = await supabase
    .from('trends')
    .upsert(rows, { onConflict: 'source_id' });
  if (error) console.error('Supabase upsert error:', error);
}

async function main() {
  await Promise.all([
    fetchGoogleTrends(),
    fetchTwitchRising(),
  ]);
  console.log('完了！');
}

main().catch(console.error);
