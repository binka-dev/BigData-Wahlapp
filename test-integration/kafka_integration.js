const { v4: uuidv4 } = require('uuid');
const { Kafka } = require('kafkajs')
const express = require('express')

const app = express() 

const kafka = new Kafka({
    clientId: 'test_integration',
    brokers: ["my-cluster-kafka-bootstrap:9092"]
})
 
const producer = kafka.producer()
const consumer = kafka.consumer({ groupId: 'log-group' })
 
const log_consumer = async() => {
    await consumer.connect()
    await consumer.subscribe({ topic: 'election_input', fromBeginning: true })
    await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          console.log("Message received: " + message.value.toString())
        },
      })
}

const run = async() => {
    await producer.connect()

    // Genearte sample election data
    election_object = {
        election_id: "fdf293ee-bace-40c9-845d-1fb559b50e72",
        votes:[
            {party_id: 1, number_of_votes: Math.floor(Math.random() * 1000)}, 
            {party_id: 2, number_of_votes: Math.floor(Math.random() * 1000)},
            {party_id: 3, number_of_votes: Math.floor(Math.random() * 1000)},
            {party_id: 4, number_of_votes: Math.floor(Math.random() * 1000)},
            {party_id: 5, number_of_votes: Math.floor(Math.random() * 1000)},
            {party_id: 6, number_of_votes: Math.floor(Math.random() * 1000)}
        ]
    }

    await producer.send({
        topic: 'election_input',
        messages: [
        { value: JSON.stringify(election_object)},
        ],
    })
}

app.get("/", (req, res) => {
    run().then(() => {
        console.log("Test event send")
        res.send("success")
    })
})


app.listen(80, function () {
	console.log("Node app is running")
})
log_consumer()