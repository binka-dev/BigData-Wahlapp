const { Kafka } = require('kafkajs')
const express = require('express')

const app = express() 

const kafka = new Kafka({
    clientId: 'test_integration',
    brokers: ["my-cluster-kafka-bootstrap:9092"],
    retry: {
        retries: 0
    }
})
 
const producer = kafka.producer()
 
const run = async() => {
    await producer.connect()
    await producer.send({
        topic: 'election_input',
        messages: [
        { value: 'Hello KafkaJS user!' },
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