import axios from "axios";
import { getSettings } from "../db.js";

export interface ZoomMeeting {
  id: string;
  joinUrl: string;
  startUrl: string;
}

export async function createZoomMeeting(input: { topic: string; startsAt: string; endsAt: string }): Promise<ZoomMeeting> {
  const s = getSettings();
  if (!s.zoomAccountId || !s.zoomClientId || !s.zoomClientSecret) {
    throw new Error("Zoom Server-to-Server OAuth credentials are not configured");
  }
  const token = await axios.post("https://zoom.us/oauth/token", null, {
    params: { grant_type: "account_credentials", account_id: s.zoomAccountId },
    auth: { username: s.zoomClientId, password: s.zoomClientSecret },
  });
  const duration = Math.max(1, Math.round((new Date(input.endsAt).getTime() - new Date(input.startsAt).getTime()) / 60_000));
  const meeting = await axios.post(
    `https://api.zoom.us/v2/users/${encodeURIComponent(s.zoomUserId || "me")}/meetings`,
    {
      topic: input.topic, type: 2, start_time: input.startsAt, duration,
      settings: { join_before_host: false, waiting_room: true, mute_upon_entry: true },
    },
    { headers: { Authorization: `Bearer ${token.data.access_token}` } },
  );
  return { id: String(meeting.data.id), joinUrl: meeting.data.join_url, startUrl: meeting.data.start_url };
}
