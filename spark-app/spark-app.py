from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.types import ArrayType, IntegerType, MapType, StringType, StructField, StructType, TimestampType
import mysqlx

dbOptions = {"host": "my-app-mysql-service", 'port': 33060, "user": "root", "password": "mysecretpw"}
dbSchema = 'election_app'
slidingDuration = '1 minute'

# Example Part 1
# Create a spark session
spark = SparkSession.builder \
    .appName("Structured Streaming").getOrCreate()

# Set log level
spark.sparkContext.setLogLevel('WARN')

# Example Part 2
# Read messages from Kafka
kafkaMessages = spark \
    .readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers",
            "my-cluster-kafka-bootstrap:9092") \
    .option("subscribe", "election_input") \
    .option("startingOffsets", "earliest") \
    .load()

# Define schema of tracking data
electionMessageSchema = StructType([
    StructField("election_id", StringType()),
    StructField("votes", ArrayType(
        StructType([
            StructField("party_id", IntegerType()),
            StructField("number_of_votes", IntegerType())
        ])
    ))
])

# Example Part 3
# Convert value: binary -> JSON -> fields + parsed timestamp
electionMessages = kafkaMessages.select(
    # Extract 'value' from Kafka message (i.e., the tracking data)
    column("value").cast("string"),
    from_json(
        column("value").cast("string"),
        electionMessageSchema
    ).alias("json")
).select(
    col('json.election_id').alias('election_id'),
    explode('json.votes').alias('votes')
).select(
    col('election_id'),
    col('votes.*')
)

# Example Part 4
# Compute most popular slides
election = electionMessages.groupBy(['election_id', 'party_id']).agg(sum('number_of_votes').alias('sum_votes'))

# Example Part 5
# Start running the query; print running counts to the console
consoleDump = election \
    .writeStream \
    .trigger(processingTime=slidingDuration) \
    .outputMode("update") \
    .format("console") \
    .option("truncate", "false") \
    .start()

# Example Part 6


def saveToDatabase(batchDataframe, batchId):
    # Define function to save a dataframe to mysql
    def save_to_db(iterator):
        # Connect to database and use schema
        session = mysqlx.get_session(dbOptions)
        session.sql("USE election_app").execute()

        for row in iterator:
            # Run upsert (insert or update existing)
            sql = session.sql("INSERT INTO election_results "
                              "(election_uuid, party_id, number_of_votes) VALUES (?, ?, ?) "
                              "ON DUPLICATE KEY UPDATE number_of_votes=?")
            sql.bind(row.election_id, row.party_id, row.sum_votes, row.sum_votes).execute()

        session.close()

    # Perform batch UPSERTS per data partition
    batchDataframe.foreachPartition(save_to_db)

# Example Part 7


dbInsertStream = election.writeStream \
    .trigger(processingTime=slidingDuration) \
    .outputMode("update") \
    .foreachBatch(saveToDatabase) \
    .start()

# Wait for termination
spark.streams.awaitAnyTermination()
