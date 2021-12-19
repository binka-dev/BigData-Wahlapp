# Use Case: An election app
## Description
A simple App to model several elections with the possibility to vote

```json
{
  "election_id": "fdf293ee-bace-40c9-845d-1fb559b50e72",
  "votes":
  [
    {
      "party_id": 2, 
      "number_of_votes": 100
    }, 
    {
      "party_id": 4, 
      "number_of_votes": 70
    }, 
  ]
}
```

## Prerequisites

A running Strimzi.io Kafka operator

```bash
helm repo add strimzi http://strimzi.io/charts/
helm install my-kafka-operator strimzi/strimzi-kafka-operator
kubectl apply -f https://farberg.de/talks/big-data/code/helm-kafka-operator/kafka-cluster-def.yaml
```

A running Hadoop cluster with YARN (for checkpointing)

```bash
helm repo add stable https://charts.helm.sh/stable
helm install --namespace=default --set hdfs.dataNode.replicas=1 --set yarn.nodeManager.replicas=1 --set hdfs.webhdfs.enabled=true my-hadoop-cluster stable/hadoop
```

## Deploy

To develop using [Skaffold](https://skaffold.dev/), use `skaffold dev`. 
