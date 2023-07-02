const express = require("express");
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
const cors = require("cors");
const bodyParser = require("body-parser");
const { MongoClient, ServerApiVersion } = require("mongodb");
const session = require("express-session");
require("dotenv").config();

const MONGO_URI = `mongodb+srv://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}@proto.deabf88.mongodb.net/?retryWrites=true&w=majority`;
const PASSPHRASE = process.env.PASSPHRASE;
const SESSION_SECRET = process.env.SESSION;
const DOMAIN = "http://localhost";

const mongoClient = new MongoClient(MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

const DBNAME = "app";

async function mongoConnect() {
  try {
    await mongoClient.connect();
  } catch (err) {
    console.error(err);
  }
}

const corsOptions = {
  origin: `${DOMAIN}:3001`,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

const app = express();
app.use(express.json());
app.use(bodyParser.json());
app.use(cors(corsOptions));
app.use(
  session({
    name: 'connect.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { 
      httpOnly: true,
      secure: false,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'lax', },
      path: '/'
    })
);

const YOUTUBE_CATEGORY_IDS = {
  10: "music",
  15: "animals",
  17: "sports",
  20: "gaming",
  23: "comedy",
  25: "news"
}
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = `${DOMAIN}:3000/auth/google/callback`;
const CLIENT_REDIRECT_URI = `${DOMAIN}:3001/`;
const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/plus.me",
];

function getOAuth2Client(req) {
  const oauth2Client = new OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  if (req.session.tokens) {
    oauth2Client.setCredentials(req.session.tokens);
  }
  return oauth2Client;
}

app.get("/auth", (req, res) => {
  const oauth2Client = getOAuth2Client(req);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  res.json({ auth_url: authUrl });
});

app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  const oauth2Client = getOAuth2Client(req);
  const { tokens } = await oauth2Client.getToken(code);
  req.session.tokens = tokens;
  res.redirect(CLIENT_REDIRECT_URI);
});

function getPlaylistItems(youtube, channel, constraints) {
  return new Promise((resolve) => {
    youtube.playlistItems
      .list({
        part: "id,snippet",
        playlistId: channel.contentDetails.relatedPlaylists.uploads,
        maxResults: constraints["numVideos"],
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
          getPlaylistItems(youtube, channel, constraints)
        );
        resolve(Promise.all(promiseList));
      })
  });
}

// Use for users with no data/use on video clicked
function getVideosBySubscribers(youtube, constraints={numSubscriptions: 5, numVideos: 5}) {
  return new Promise(async (resolve) => {
    await youtube.subscriptions
      .list({
        part: "snippet,contentDetails",
        mine: "true",
        maxResults: constraints["numSubscriptions"],
      })
      .then(async (data) => {
        let channelIds = [];
        data.data.items.forEach((channel) => {
          channelIds.push(channel.snippet.resourceId.channelId);
        });
        getChannels(youtube, channelIds, constraints).then((channels) => {
          resolve(channels);
        });
      });
  });
}

function getDetailedVideoInfo(youtube, videoIds) {
  // TODO: Additional call (think about maybe reducing initial data)
  return new Promise(async (resolve) => {
    await youtube.videos.list({
      part: ["snippet", "contentDetails"],
      id: videoIds
    }).then((data) => {
      resolve(data);
    })
  });
}

function getRelevantVideoFields(item) {
  const videoTitle = item["snippet"]["title"];
  const channelId = item["snippet"]["channelId"];
  const channelTitle = item["snippet"]["channelTitle"];
  const views = 0;
  const uploadDate = "";
  const videoLength = item["contentDetails"]["duration"];
  const categoryId = item["snippet"]["categoryId"];
  const tags = item["snippet"]["tags"];
  const thumbnail = item["snippet"]["thumbnails"]["medium"]["url"];
  return {
    videoTitle: videoTitle,
    channelId: channelId,
    channelTitle: channelTitle,
    views: views,
    uploadDate: uploadDate,
    videoLength: videoLength,
    categoryId: categoryId,
    tags: tags,
    thumbnail: thumbnail,
  };
}

function writeVideoDataToDatabase(cid, bfg, rawScoreVal=50) {
  const videoDataWrites = [];
  const usageDataWrites = [];
  bfg.forEach((item) => {
    // both videos and usage data
    const videoId = item["id"];

    // only video data
    const videoDataObj = getRelevantVideoFields(item);
    // ...snippet.publishedAt (?)

    // only usage data
    const timeSpentWatching = 0;
    const numClicks = 0;
    const numTimesShown = 0;
    const rawScore = rawScoreVal;
    const isLiked = 0; // -1, 0, 1
    const isSubscribed = false;

    videoDataWrites.push(
      {
        updateOne: {
          filter: { [videoId]: {$exists: true}},
          update: {$set: { [videoId]: videoDataObj}},
          upsert: true
        }
      }
    );

    usageDataWrites.push(
      {
        updateOne: {
          filter: { [`${cid}`]: {$exists: true}},
          update: {$set: { [`${cid}.data.${videoId}`]: {
            timeSpentWatching: timeSpentWatching,
            numClicks: numClicks,
            numTimesShown: numTimesShown,
            isLiked: isLiked,
            isSubscribed: isSubscribed,
            rawScore: rawScore
          }}},
          upsert: true
        }
      }
    );
  });

  const db = mongoClient.db(DBNAME);
  const profilesCollection = db.collection("dev");
  const videosCollection = db.collection("videos");

  try {
    videosCollection.bulkWrite(videoDataWrites);
  } catch (err) {
    console.error(err);
  }

  try {
    profilesCollection.bulkWrite(usageDataWrites);
  } catch (err) {
    console.error(err);
  }
}

function filterVideos(videos, filters) {
  for (let i = 0; i < videos.length; i++) {
    const id = Object.keys(videos[i])[1];
    const metadata = videos[i][id];
    const category = YOUTUBE_CATEGORY_IDS[parseInt(metadata["categoryId"])];
    const duration = metadata["videoLength"];
    const minutesMatch = duration.match(/(\d+)M/);
    const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
    if (minutes < filters["vidlength"]) {
      // console.log(`Removing video because length was ${minutes}.`);
      videos[i] = null;
    }
    else if(Object.keys(filters).includes(category) && !filters[category]) {
      // console.log(`Removing video because category was ${category}.`);
      videos[i] = null;
    }
  }
  const filteredVideos = videos.filter(item => item !== null);
  return filteredVideos;
}

async function adjustScoresOnClick(clickedId, clickedVideo, videos, cid, youtube, search=0) {
  mongoConnect();
  const collection = mongoClient.db(DBNAME).collection("dev");
  const tags = clickedVideo["tags"];
  if (!tags || !tags.length || tags.length < 2) {
    return;
  }
  const directTagSearchResults = await youtube.search.list({
    part: ["snippet"],
    q: `${tags[0]} ${tags[1]}`,
    limit: 10
  });

  const NUM_RANDOMS = 3;
  let randomTagCombos = []
  for (let i = 0; i < NUM_RANDOMS; i++) {
    const rand1 = Math.floor(Math.random()*tags.length);
    let rand2 = Math.floor(Math.random()*tags.length);
    if (rand1 == rand2) {
      rand2 = (rand2 + 1 >= tags.length) ? 0 : rand2 + 1;
    }
    if (i < NUM_RANDOMS - 1) {
      randomTagCombos.push(`${rand1} ${rand2}%7C`);
    } else {
      randomTagCombos.push(`${rand1} ${rand2}`);
    }
  }

  const randomTagSearchResults = await youtube.search.list({
    part: ["snippet"],
    q: randomTagCombos.join(''),
    limit: 10
  });

  const videoIds = [];
  directTagSearchResults["data"]["items"].forEach((item) => {
    videoIds.push(item["id"]["videoId"]);
  });
  randomTagSearchResults["data"]["items"].forEach((item) => {
    videoIds.push(item["id"]["videoId"]);
  });
  const bigFriendlyObject = await getDetailedVideoInfo(youtube, videoIds);
  writeVideoDataToDatabase(cid, bigFriendlyObject["data"]["items"], 57);
  const numAddedVideos = bigFriendlyObject.length; // TODO: Delete videos when there are enough

  const bulkUpdates = []
  if (search <= 0) {
    search = videos.length;
  }
  for (let i = 0; i < videos.length; i++) {
    const videoId = Object.keys(videos[i])[1];
    let diff = -1;
    if (clickedVideo["categoryId"] === videos[i][videoId]["categoryId"]) {
      diff += 2;
    }
    if (clickedVideo["channelId"] === videos[i][videoId]["channelId"]) {
      diff += 4;
    }
    if (clickedId === videoId) {
      bulkUpdates.push(
        {
          updateOne: {
            filter: { [`${cid}`]: {$exists: true}},
            update: {$set: { [`${cid}.data.${videoId}.rawScore`]: 45}}
          }
        }
      );
    } else if (i >= search) {
      bulkUpdates.push(
        {
          updateOne: {
            filter: { [`${cid}`]: {$exists: true}},
            update: {$unset: {[`${cid}.data.${videoId}.rawScore`] : ""}}
          }
        }
      );
    } else {
      bulkUpdates.push(
        {
          updateOne: {
            filter: { [`${cid}`]: {$exists: true}},
            update: {$inc: {[`${cid}.data.${videoId}.rawScore`]: diff}}
          }
        }
      );
    }
  }
  try {
    collection.bulkWrite(bulkUpdates);
  } catch {
    console.log("Error bulk-writing to database");
  }
}

async function getChannelUid(youtube=null, req=null) {
  if (!youtube && req) {
    const oauth2Client = getOAuth2Client(req);
    youtube = google.youtube({
      version: "v3",
      auth: oauth2Client,
    });
  }
  const data = await youtube.channels.list({
    part: "snippet",
    mine: true
  });
  return data.data.items[0].id;
}

async function getIsVerified(cid) {
  const db = mongoClient.db(DBNAME);
  const collection = db.collection("dev");
  const query = {[`${cid}`]: {$exists: true}};
  const dbres = await collection.findOne(query);
  if (!dbres) {
    return false;
  }
  return dbres[`${cid}`]["authenticated"];
}

async function getChannelUidAndVerify(youtube=null, req=null) {
  const cid = await getChannelUid(youtube, req);
  if (!cid) {
    throw new Error("User does not exist");
  }
  mongoConnect();
  const isVerified = await getIsVerified(cid);  
  if (!isVerified) {
    throw new Error("User is unverified. This app is in closed alpha.");
  }
  return cid;
}


/*************************** ROUTES ***************************/

app.post("/verify-user", async (req, res) => {
  if (!req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  const cid = await getChannelUid(null, req);
  mongoConnect();

  if (req.body.passphrase === PASSPHRASE) {
    const db = mongoClient.db(DBNAME);
    const collection = db.collection("dev");
    const query = {[`${cid}`]: {$exists: true}};
    const update = {$set: {[`${cid}.authenticated`]: true}};
    await collection.updateOne(query, update, {upsert: true});
    res.status(200).send();
  } else {
    res.status(403).send();
  }
});

app.post("/check-verified", async (req, res) => {
  if (!req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  const cid = await getChannelUid(null, req);
  const isVerified = await getIsVerified(cid);
  if (isVerified) {
    res.status(200).send();
  } else {
    res.status(201).send();
  }
})

app.post("/firstpass", async (req, res) => {
  const oauth2Client = getOAuth2Client(req);

  mongoConnect();

  if (!req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });

  try {
    const cid = await getChannelUidAndVerify(youtube);
    const db = mongoClient.db(DBNAME);
    const collection = db.collection("dev");
    const query = {[`${cid}.settings`]: {$exists: true}};
    const userData = await collection.findOne(query);

    if (!userData) {
      return;
    }

    const filters = userData[cid]["settings"];
    const usageData = userData[cid]["data"];
    if (!usageData) {
      const playlistItemsObj = await getVideosBySubscribers(youtube, {numSubscriptions: 10, numVideos: 5});

      const idsList = [];
      playlistItemsObj.forEach((channel) => {
        channel.forEach((item) => {
          idsList.push(item["snippet"]["resourceId"]["videoId"]);
        });
      });
      const bigFriendlyObject = await getDetailedVideoInfo(youtube, idsList);

      writeVideoDataToDatabase(cid, bigFriendlyObject["data"]["items"]);
      if (filters) {
        res.status(269).send();
        return;
      }
    }

    res.status(200).send();
  } catch {
    res.status(403).send();
  }
});

app.post("/retrieveVideos", async (req, res) => {
  mongoConnect();

  if (!req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  try {
    const cid = await getChannelUidAndVerify(null, req);
    const db = mongoClient.db(DBNAME);
    const usageCollection = db.collection("dev");
    const videosCollection = db.collection("videos");
    const usageQuery = {[`${cid}.settings`]: {$exists: true}};
    const userData = await usageCollection.findOne(usageQuery);

    if (!userData) {
      return;
    }

    const filters = userData[cid]["settings"];
    const usageData = userData[cid]["data"];

    if (!filters || !usageData) {
      return;
    }
    const queryArray = Object.keys(usageData).map((key) => {
      return {[key]: {$exists: true}};
    });
    const videosQuery = { $or: queryArray };
    const videos = await videosCollection.find(videosQuery).toArray();
    const filteredVideos = filterVideos(videos, filters);
    for (let i = 0; i < filteredVideos.length; i++) {
      const videoId = Object.keys(filteredVideos[i])[1];
      filteredVideos[i]["rawScore"] = usageData[videoId]["rawScore"];
    }
    
    // Sort
    try {
      filteredVideos.sort((a,b) => (b.rawScore - a.rawScore));
    } catch {
      console.log("sorting didn't work (:");
    }

    req.session.lastPayload = filteredVideos;

    res.json(filteredVideos);
  } catch {
    res.status(403).send();
  }
});

app.post("/logSearchResults", async (req, res) => {
  if (!req.session || !req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  const query = req.body;

  mongoConnect();
  const oauth2Client = getOAuth2Client(req);
  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });
  const searchResults = await youtube.search.list({
    part: ["snippet"],
    q: query["query"]
  });
  const videoIds = [];
  searchResults["data"]["items"].forEach((item) => {
    videoIds.push(item["id"]["videoId"]);
  });
  
  try {
    const cid = await getChannelUidAndVerify(youtube);
    const bigFriendlyObject = await getDetailedVideoInfo(youtube, videoIds);
    writeVideoDataToDatabase(cid, bigFriendlyObject["data"]["items"], 9100);
    res.json({numItems: videoIds.length});
  } catch {
    res.status(403).send();
  }
});

app.post("/delete_data", async (req, res) => {
  if (!req.session || !req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  try {
    const cid = await getChannelUidAndVerify(null, req);
    mongoConnect();
    const db = mongoClient.db(DBNAME);
    const collection = db.collection("dev");
    const query = {[`${cid}.data`] : {$exists : true}};
    const update = {$unset : {[`${cid}.data`] : ""}};
    collection.updateOne(query, update);
  } catch {
    res.status(403).send();
  }
});

app.post("/logout", (req, res) => {
  const oauth2Client = getOAuth2Client(req);
  req.session.destroy((err) => {
    if (err) {
      console.error(err);
      res.status(500).send("An error occurred while logging out.");
      return;
    }

    oauth2Client.setCredentials(null);

    oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
    });
    res.clearCookie('connect.sid', { path: '/', sameSite: 'lax', httpOnly: true, secure: false,maxAge: 24 * 60 * 60 * 1000 });
    res.status(200).send();
  });
});

app.post("/ping", async (req, res) => {
  if (!req.session || !req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  res.send("pong");
});

app.post("/update_profile", async (req, res) => {
  if (!req.session || !req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  try {
    req.body["vidlength"] = Math.max(parseInt(req.body["vidlength"]));
  } catch {
    req.body["vidlength"] = 0;
  }

  try {
    cid = await getChannelUid(null, req);
    mongoConnect();

    const db = mongoClient.db(DBNAME);
    const collection = db.collection("dev");
    const query = {[`${cid}`]: {$exists: true}};
    const update = {
      $set: {
        [`${cid}.settings`]: req.body,
      }
    }
    collection.updateOne(query, update, {upsert: true});
    res.json({status: "happy"});
  } catch {
    res.status(403).send();
  }
});

app.post("/get_profile", async (req, res) => {
  if (!req.session || !req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  try {
    const cid = await getChannelUid(null, req);
    mongoConnect();
    const db = mongoClient.db(DBNAME);
    const collection = db.collection("dev");
    const query = {[`${cid}.settings`]: {$exists: true}};
    const dbres = await collection.findOne(query);
    try {
      res.json(dbres[`${cid}`]["settings"]);
    } catch {
      res.json({
        vidlength: "0",
        gaming: true,
        music: true,
        news: true,
        animals: true,
        sports: true,
        comedy: true
      });
    }
  } catch {
    res.status(403).send();
  }
});

app.post("/video_clicked", async (req, res) => {
  if (!req.session || !req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  const oauth2Client = getOAuth2Client(req);
  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });
  
  try {
    const cid = await getChannelUidAndVerify(youtube);
    mongoConnect();

    let adjustments = req.session.lastPayload;
    adjustScoresOnClick(req.body.id, req.body.clickedVideo, adjustments, cid, youtube, req.body.search);

    res.status(200).send();
  } catch {
    res.status(403).send();
  }
});

app.post("/debug", async (req, res) => {
  if (!req.session || !req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  const oauth2Client = getOAuth2Client(req);
  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });

  const cid = await getChannelUid(youtube);

  mongoConnect();
  const db = mongoClient.db(DBNAME);
  const collection = db.collection("dev");
  const query = {[cid]: {}};
  const update = {[cid]: {settings: {test: "test"}, data: {}}};
  collection.updateOne(query, {$set: update});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
