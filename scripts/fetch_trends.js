import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import ws from 'ws';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  {
    realtime: { transport: ws }
  }
);

// ジャンル判定（キーワードで自動分類）
function detectGenre(title = '', tags = []) {
  const text = (title + ' ' + tags.join(' ')).toLowerCase();
  if (/game|gaming|ゲーム|minecraft|fortnite|apex/.test(text)) return 'ゲーム';
  if (/music|song|歌|音楽|mv|official/.test(text)) return '音楽';
  if (/cook|recipe|料理|食べ|グルメ|vlog/.test(text)) return '料理';
  if (/fashion|outfit|ファッション|コーデ/.test(text)) return 'ファッション';
  if (/sport|soccer|baseball|スポーツ|野球|サッカー/.test(text)) return 'スポーツ';
  return 'その他';
}

// 注目度スコア計算（再生数・視聴者数から1〜3を返す）
function calcHeat(value, thresholds) {
  if (value >= thresholds[1]) return 3;
  if (value >= thresholds[0]) return 2;
  return 1;
}

// ─── YouTube ───────────────────────────────────────────
async function fetchYouTube() {
  console.log('Fetching YouTube trends...');
  const regionCode = 'JP';
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=${regionCode}&maxResults=20&key=${process.env.YOUTUBE_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.items) {
    console.error('YouTube API error:', data);
    return;
  }

  const rows = data.items.map(item => ({
    platform:    'YouTube',
    genre:       detectGenre(item.snippet.title, item.snippet.tags || []),
    title:       item.snippet.title,
    description: item.snippet.description?.slice(0, 120) || '',
    url:         `https://www.youtube.com/watch?v=${item.id}`,
    heat:        calcHeat(parseInt(item.statistics.viewCount || 0), [100000, 1000000]),
    source_id:   `yt_${item.id}`,
    expires_at:  new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), // 48時間後に非表示
  }));

  await upsertTrends(rows);
  console.log(`YouTube: ${rows.length}件保存`);
}

// ─── Twitch ────────────────────────────────────────────
async function getTwitchToken() {
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const data = await res.json();
  return data.access_token;
}

async function fetchTwitch() {
  console.log('Fetching Twitch trends...');
  const token = await getTwitchToken();

  const res = await fetch('https://api.twitch.tv/helix/streams?first=20', {
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

  const rows = data.data.map(stream => ({
    platform:    'Twitch',
    genre:       detectGenre(stream.title, [stream.game_name || '']),
    title:       stream.title || stream.game_name,
    description: `${stream.game_name} • 視聴者 ${stream.viewer_count.toLocaleString()}人`,
    url:         `https://www.twitch.tv/${stream.user_login}`,
    heat:        calcHeat(stream.viewer_count, [5000, 50000]),
    source_id:   `tw_${stream.id}`,
    expires_at:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24時間後に非表示
  }));

  await upsertTrends(rows);
  console.log(`Twitch: ${rows.length}件保存`);
}

// ─── Supabase へ保存 ────────────────────────────────────
async function upsertTrends(rows) {
  const { error } = await supabase
    .from('trends')
    .upsert(rows, { onConflict: 'source_id' });

  if (error) console.error('Supabase upsert error:', error);
}

// ─── メイン ─────────────────────────────────────────────
async function main() {
  await Promise.all([
    fetchYouTube(),
    fetchTwitch(),
  ]);
  console.log('完了！');
}

main().catch(console.error);
