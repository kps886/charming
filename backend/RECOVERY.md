# Shop database recovery

The proposed operating targets are a recovery point within 15 minutes of the incident and restored service within 60 minutes. These targets cover order and inventory writes. The business owner should confirm them against order volume and the cost of downtime.

## Isolated restore drill

With MongoDB Database Tools on PATH, start two disposable local MongoDB deployments on different ports. From the repository root run:

```sh
node backend/scripts/recovery-drill.js mongodb://127.0.0.1:27018/ mongodb://127.0.0.1:27019/
```

The drill creates a uniquely named fixture database, writes a refunded order and its product, takes a compressed BSON archive, restores it to the empty second deployment, and checks the entire order, linked product, and payment-reference index. The fixture is quiescent during the dump. Timing starts immediately before restore and ends after the verification queries. Both fixture databases and the temporary archive are removed afterward.

On 20 November 2026, a run against two independent local single-node replica sets took **0.42 seconds** to restore and verify one order and one product. The checks included a ₹123.45 order, its Razorpay payment and refund references, refunded payment status, and seven available units. This measures a small local restore. Production data volume, cluster provisioning and application cutover still need a timed Atlas rehearsal.

## Production rehearsal

1. Record the Atlas tier, backup policy, last usable snapshot, point-in-time recovery window and retention. Establish the recovery point that the configured policy can actually meet. [Atlas backup capabilities](https://www.mongodb.com/docs/atlas/backup/cloud-backup/overview/)
2. Record the incident timestamp and recovery point in UTC. Restore an existing backup into an isolated cluster on a compatible MongoDB version. Keep the application workers disconnected throughout verification.
3. Compare a preselected sample of recent orders with the incident ledger and Razorpay records. Check the stored payment ID, currency and amount, refunded or pending state, purchased quantities, available stock, outstanding reservations and promo holds. Include an order and refund close to the recovery point.
4. Confirm indexes are present and run an authenticated read-only checkout review on the restored environment. Record snapshot age, restore duration, verification duration and estimated cutover time. Record any writes that need replay and payments needing reconciliation before reopening checkout.
