import ky from "ky";
import ObsidianGoogleDrive from "main";
import { Notice } from "obsidian";

export const getDriveKy = (t: ObsidianGoogleDrive) =>
	ky.create({
		prefixUrl: "https://www.googleapis.com/",
		timeout: 30000, // 30초 타임아웃
		retry: {
			limit: 3,
			methods: ['get', 'post', 'patch', 'delete'],
			statusCodes: [408, 413, 429, 500, 502, 503, 504], // 404 제외 - 재시도해도 해결되지 않음
			backoffLimit: 3000, // 최대 3초 대기
		},
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
			beforeRetry: [
				async ({ request, options, error, retryCount }) => {
					// Rate limiting 감지 시 추가 대기 (HTTPError 타입 체크)
					if (error && 'response' in error && (error as any).response?.status === 429) {
						const response = (error as any).response;
						const retryAfter = response.headers.get('retry-after');
						const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, retryCount) * 1000;
						await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 10000)));
					}
					
					console.log(`Retrying request (${retryCount + 1}/3): ${request.url}`);
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