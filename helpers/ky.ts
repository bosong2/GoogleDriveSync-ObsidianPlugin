import ky from "ky";
import ObsidianGoogleDrive from "main";
import { Notice } from "obsidian";

export const getDriveKy = (t: ObsidianGoogleDrive) =>
	ky.create({
		prefixUrl: "https://www.googleapis.com/",
		hooks: {
			beforeRequest: [
				async (request) => {
					if (
						t.accessToken.expiresAt < Date.now() &&
						t.settings.refreshToken
					) {
						await refreshAccessToken(t);
					}
					request.headers.set(
						"Authorization",
						`Bearer ${t.accessToken.token}`
					);
				},
			],
		},
	});

export const refreshAccessToken = async (t: ObsidianGoogleDrive) => {
	try {
		const res = await ky
			.post(`${t.settings.ServerURL}/api/access`, {
				json: {
					refresh_token: t.settings.refreshToken,
				},
			})
			.json<any>();

		if (!res.access_token) {
			new Notice(
				"Invalid refresh token. Please get a new one from our website."
			);
			return;
		}

		t.accessToken = {
			token: res.access_token,
			expiresAt: Date.now() + res.expires_in * 1000,
		};

		return true;
	} catch (e) {
		new Notice("Failed to refresh access token. Please check your server URL, network connection, and CORS settings.");
		return false;
	}
};