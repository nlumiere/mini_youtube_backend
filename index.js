const express = require("express");
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
const cors = require("cors");
const bodyParser = require("body-parser");
const mongodb = require("mongodb");

const corsOptions = {
  origin: "http://localhost:3001",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

const app = express();
app.use(bodyParser.json());
app.use(cors(corsOptions));

const clientId =
  "832264626068-gssj135nge1f3tu6pbnqd9bcgafdrfvb.apps.googleusercontent.com";
const clientSecret = "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";
const redirectURI = "http://localhost:3000/auth/google/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/plus.me",
];

const oauth2Client = new OAuth2(clientId, clientSecret, redirectURI);

app.get("/", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });

  res.json({ auth_url: authUrl });
});

app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  res.redirect(`http://localhost:3001?accessToken=${tokens.access_token}`);
});

function getPlaylistItems(youtube, channel, constraints) {
  return new Promise((resolve) => {
    youtube.playlistItems
      .list({
        part: "id,snippet",
        playlistId: channel.contentDetails.relatedPlaylists.uploads,
        maxResults: 5,
      })
      .then((playlistItemsData) => {
        resolve(playlistItemsData.data.items);
      });
  });
}

function getChannels(youtube, channelIds, constraints) {
  return new Promise((resolve) => {
    youtube.channels
      .list({
        part: "contentDetails,statistics",
        id: channelIds,
      })
      .then((channelData) => {
        const promiseList = channelData.data.items.map((channel) =>
          getPlaylistItems(youtube, channel)
        );
        resolve(Promise.all(promiseList));
      });
  });
}

function firstPass(youtube, constraints = {}) {
  return new Promise(async (resolve) => {
    await youtube.subscriptions
      .list({
        part: "snippet,contentDetails",
        mine: "true",
        maxResults: 5,
      })
      .then(async (data) => {
        let channelIds = [];
        data.data.items.forEach((channel) => {
          channelIds.push(channel.snippet.resourceId.channelId);
        });
        getChannels(youtube, channelIds).then((channels) => {
          resolve(channels);
        });
      });
  });
}

app.post("/firstpass", async (req, res) => {
  const accessToken = req.body.accessToken;
  if (!accessToken) {
    return res.status(400).json({ error: "Access token is required" });
  }

  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });

  const bigFriendlyObject = await firstPass(youtube);
  res.json(bigFriendlyObject);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
