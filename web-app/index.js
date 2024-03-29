const os = require('os')
const dns = require('dns').promises
const { program: optionparser } = require('commander')
const { Kafka } = require('kafkajs')
const mysqlx = require('@mysql/xdevapi');
const MemcachePlus = require('memcache-plus');
const express = require('express')

const app = express()
const cacheTimeSecs = 15
// Including "others"
const numberOfParties = 8

// The amount of votes per click
const numVotesPerClick = 100

// -------------------------------------------------------
// Command-line options
// -------------------------------------------------------

let options = optionparser
	.storeOptionsAsProperties(true)
	// Web server
	.option('--port <port>', "Web server port", 3000)
	// Kafka options
	.option('--kafka-broker <host:port>', "Kafka bootstrap host:port", "my-cluster-kafka-bootstrap:9092")
	.option('--kafka-topic-tracking <topic>', "Kafka topic to tracking data send to", "election_input")
	.option('--kafka-client-id < id > ', "Kafka client ID", "tracker-" + Math.floor(Math.random() * 100000))
	// Memcached options
	.option('--memcached-hostname <hostname>', 'Memcached hostname (may resolve to multiple IPs)', 'my-memcached-service')
	.option('--memcached-port <port>', 'Memcached port', 11211)
	.option('--memcached-update-interval <ms>', 'Interval to query DNS for memcached IPs', 5000)
	// Database options
	.option('--mysql-host <host>', 'MySQL host', 'my-app-mysql-service')
	.option('--mysql-port <port>', 'MySQL port', 33060)
	.option('--mysql-schema <db>', 'MySQL Schema/database', 'election_app')
	.option('--mysql-username <username>', 'MySQL username', 'root')
	.option('--mysql-password <password>', 'MySQL password', 'mysecretpw')
	// Misc
	.addHelpCommand()
	.parse()
	.opts()

// -------------------------------------------------------
// Database Configuration
// -------------------------------------------------------

const dbConfig = {
	host: options.mysqlHost,
	port: options.mysqlPort,
	user: options.mysqlUsername,
	password: options.mysqlPassword,
	schema: options.mysqlSchema
};

async function executeQuery(query, data) {
	console.log("Start init session!")
	let session = await mysqlx.getSession(dbConfig)
	console.log("Got session!")
	let queryResult = await session.sql(query, data).bind(data).execute()
	console.log("returned result")

	return queryResult
}

// -------------------------------------------------------
// Memcache Configuration
// -------------------------------------------------------

//Connect to the memcached instances
let memcached = null
let memcachedServers = []

async function getMemcachedServersFromDns() {
	try {
		// Query all IP addresses for this hostname
		let queryResult = await dns.lookup(options.memcachedHostname, { all: true })

		// Create IP:Port mappings
		let servers = queryResult.map(el => el.address + ":" + options.memcachedPort)

		// Check if the list of servers has changed
		// and only create a new object if the server list has changed
		if (memcachedServers.sort().toString() !== servers.sort().toString()) {
			console.log("Updated memcached server list to ", servers)
			memcachedServers = servers

			//Disconnect an existing client
			if (memcached)
				await memcached.disconnect()

			memcached = new MemcachePlus(memcachedServers);
		}
	} catch (e) {
		console.log("Unable to get memcache servers", e)
	}
}

//Initially try to connect to the memcached servers, then each 5s update the list
getMemcachedServersFromDns()
setInterval(() => getMemcachedServersFromDns(), options.memcachedUpdateInterval)

//Get data from cache if a cache exists yet
async function getFromCache(key) {
	if (!memcached) {
		console.log(`No memcached instance available, memcachedServers = ${memcachedServers}`)
		return null;
	}
	return await memcached.get(key);
}

// -------------------------------------------------------
// Kafka Configuration
// -------------------------------------------------------

// Kafka connection
const kafka = new Kafka({
	clientId: options.kafkaClientId,
	brokers: [options.kafkaBroker],
	retry: {
		retries: 0
	}
})

const producer = kafka.producer()
// End

// Send tracking message to Kafka
async function sendTrackingMessage(data) {
	//Ensure the producer is connected
	await producer.connect()

	//Send message
	await producer.send({
		topic: 'election_input',
		messages: [
			{ value: JSON.stringify(data) }
		]
	})
}
// End

// -------------------------------------------------------
// HTML helper to send a response to the client
// -------------------------------------------------------

function sendResponse(res, html, cachedResult) {
	getElections().then(elections => {

		const electionsHtml = elections.result
			.map(e => `<li><a href='/election/${e.election_uuid}'>${e.election_name}</a></li>`)
			.join("\n")

		if(cachedResult == null) {
			cachedResult = elections.cached
		} else {
			cachedResult = cachedResult && elections.cached 
		}

		const overviewHtml = `
			<h1>Election Overview</h1>		
			<p>
				<ol style="margin-left: 2em;"> ${electionsHtml} </ol> 
			</p>
		`

		res.send(`<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Election App</title>
			<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/mini.css/3.0.1/mini-default.min.css">
			<script>
				function generateRandomVotes(electionUuid) {
					const maxRepetitions = Math.floor(Math.random() * 30)
					document.getElementById("out").innerText = "Generating " + maxRepetitions + " votes, see console output"
					for(var i = 0; i < maxRepetitions; ++i) {
						const partyId = Math.floor(Math.random() * ${numberOfParties})
						console.log("Voting for party id " + partyId)
						fetch("/vote/"+ electionUuid +"/" + partyId, {cache: 'no-cache'})
					}
				}
			</script>
		</head>
		<body>
			${overviewHtml}
			<hr>		
			${html}
			<hr>
			<h2>Information about the generated page</h4>
			<ul>
				<li>Server: ${os.hostname()}</li>
				<li>Date: ${new Date()}</li>
				<li>Using ${memcachedServers.length} memcached Servers: ${memcachedServers}</li>
				<li>Cached result: ${cachedResult}</li>
			</ul>
		</body>
	</html>
	`)

	})	
}

// -------------------------------------------------------
// Start page
// -------------------------------------------------------

// Get list of current election results (from cache or db)
async function getParties() {
	const key = 'parties'
	let cachedata = await getFromCache(key)

	if (cachedata) {
		console.log(`Cache hit for key=${key}, cachedata = ${cachedata}`)
		return { result: cachedata, cached: true }
	} else {
		console.log(`Cache miss for key=${key}, querying database`)
		let executeResult = await executeQuery("SELECT party_id, party_name, party_description FROM parties", [])
		let data = executeResult.fetchAll()
		if (data) {
			let result = data.map(row => ({ partyId: row[0], partyName: row[1], partyDesc: row[2]}) )
			console.log(`Got result=${result}, storing in cache`)
			if (memcached)
				await memcached.set(key, result, cacheTimeSecs);
			return { result: result, cached: false }
		} else {
			throw "No parties found"
		}
	}
}


// Get popular missions (from db only)
async function getVotes(electionUuid) {
	const key = 'votesForElection_' + electionUuid;
	let cachedata = await getFromCache(key)

	if (cachedata) {
		console.log(`Cache hit for key=${key}, cachedata = ${cachedata}`)
		return { result: cachedata, cached: true }
	} else {
		const query = "SELECT e.party_id, e.number_of_votes, 100 * e.number_of_votes / (SELECT SUM(number_of_votes) FROM election_results e2 WHERE e2.election_uuid='"+ electionUuid +"') as percentage_of_votes, p.party_name FROM election_results e INNER JOIN parties p ON (e.party_id = p.party_id) WHERE e.election_uuid='"+ electionUuid +"' ORDER BY number_of_votes DESC"
		let result = (await executeQuery(query, []))
			.fetchAll()
			.map(row => ({ party: row[0], count: row[1], percentage: row[2], partyName: row[3] }))
		console.log(`Got votes=${result}, storing in cache`)
		if (memcached)
			await memcached.set(key, result, cacheTimeSecs);
		return { result: result, cached: false }
	}
}

async function getElections() {
	const key = 'elections';
	let cachedata = await getFromCache(key)

	if (cachedata) {
		console.log(`Cache hit for key=${key}, cachedata = ${cachedata}`)
		return { result: cachedata, cached: true }
	} else {
		const query = "SELECT e.election_uuid, e.election_name FROM elections e ORDER BY e.election_name ASC"
		let result = (await executeQuery(query, []))
			.fetchAll()
			.map(row => ({ election_uuid: row[0], election_name: row[1] }))
		console.log(`Got elections=${result}, storing in cache`)
		if (memcached)
			await memcached.set(key, result, cacheTimeSecs);
		return { result: result, cached: false }
	}
}

// Return HTML for start page
app.get("/", (req, res) => {
	sendResponse(res, "", null)
})

app.get("/election/:electionUuid", (req, res) => {
	let electionUuid = req.params["electionUuid"]

	Promise.all([getParties(), getVotes(electionUuid), getElection(electionUuid)]).then(values => {

		const parties = values[0]
		const votes = values[1]
		const election = values[2]

		const partiesHtml = parties.result
			.map(p => `<a href='/vote/${electionUuid}/${p.partyId}'>${p.partyName}</a>`)
			.join(", ")

		const votesHtml = votes.result
			.map(vote => `<li>${vote.partyName} (${vote.count} votes - ${vote.percentage ?? 0} Prozent) </li>`)
			.join("\n")

		const html = `
			<h1>Votes for ${election.result.name}</h1>		
			<p>
				<ol style="margin-left: 2em;"> ${votesHtml} </ol> 
			</p>
			<h1>Vote for Parties:</h1>
			<p> ${partiesHtml} </p>
			<p>
				<a href="javascript: generateRandomVotes('${electionUuid}');">Randomly generate some votes</a>
				<span id="out"></span>
			</p>
		`
		sendResponse(res, html, parties.cached && votes.cached)
	})
})

// -------------------------------------------------------
// Get a specific mission (from cache or DB)
// -------------------------------------------------------

async function getParty(partyId) {
	const query = "SELECT party_name, party_description FROM parties WHERE party_id = ?"
	const key = 'party_' + partyId
	let cachedata = await getFromCache(key)

	if (cachedata) {
		console.log(`Cache hit for key=${key}, cachedata = ${cachedata}`)
		return { result: cachedata, cached: true }
	} else {
		console.log(`Cache miss for key=${key}, querying database`)

		let data = (await executeQuery(query, [partyId])).fetchOne()
		if (data) {
			let result = { party_id: partyId, name: data[0], description: data[1] }
			console.log(`Got result=${result}, storing in cache`)
			if (memcached)
				await memcached.set(key, result, cacheTimeSecs);
			return { result: result, cached: false }
		} else {
			throw "No data found for this party"
		}
	}
}

async function getElection(electionUuid) {
	const query = "SELECT election_name FROM elections WHERE election_uuid = ?"
	const key = 'election_' + electionUuid
	let cachedata = await getFromCache(key)

	if (cachedata) {
		console.log(`Cache hit for key=${key}, cachedata = ${cachedata}`)
		return { result: cachedata, cached: true }
	} else {
		console.log(`Cache miss for key=${key}, querying database`)

		let data = (await executeQuery(query, [electionUuid])).fetchOne()
		if (data) {
			let result = { name: data[0]}
			console.log(`Got result=${result}, storing in cache`)
			if (memcached)
				await memcached.set(key, result, cacheTimeSecs);
			return { result: result, cached: false }
		} else {
			throw "No data found for this election"
		}
	}
}


app.get("/vote/:electionUuid/:partyId", (req, res) => {
	let partyId = req.params["partyId"]
	let electionUuid = req.params["electionUuid"]
	console.log("Received party id:" + partyId)

	// 100 votes per click
	let election_object = {
        election_id: electionUuid,
        votes:[
            {party_id: Number(partyId), number_of_votes: numVotesPerClick}, 
        ]
    }

	// Send the tracking message to Kafka
	sendTrackingMessage(election_object)
		.then(() => console.log("Sent to kafka"))
		.catch(e => console.log("Error sending to kafka", e))

	// Send reply to browser
	getParty(partyId).then(data => {
		sendResponse(res, `<h1>${data.result.name}</h1><p>${numVotesPerClick} Stimmen für: ${data.result.name}</p>` +
			data.result.description.split("\n").map(p => `<p>${p}</p>`).join("\n"),
			data.cached
		)
	}).catch(err => {
		sendResponse(res, `<h1>Error</h1><p>${err}</p>`, false)
	})
});

// -------------------------------------------------------
// Main method
// -------------------------------------------------------

app.listen(options.port, function () {
	console.log("Node app is running at http://localhost:" + options.port)
});
