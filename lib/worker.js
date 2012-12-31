var util = require("util");
var async = require("async");
var redis = require("./connection");

var workers = null;
var pubConn = null;
var subConn = null;
var connection = null;

var runningJobs = 0;

function handleEnqueueMessage(channel, message){
	var queueName = message.replace(/^pq:(.*):enqueue$/, "$1");
	popAndStartJob(queueName);
}

function popAndStartJob(queueName){
	if(connection && runningJobs < worker.numberOfConcurrentJobs && workers[queueName]){
		++runningJobs;
		var baseName = "pq:" + queueName;
		var _jobID = null;
		var shouldRetry = true;
		async.waterfall([
			function getPendingJobID(cb){
				connection.multi()
					.zrange(baseName + ":pending", -1, -1)
					.zremrangebyrank(baseName + ":pending", -1, -1)
					.exec(function(err, results){
						var jobID = results[0];
						if(jobID && jobID.length > 0){
							cb(null, jobID);
						}else{
							shouldRetry = false;
							cb(new Error("No pending job ID"), null);
						}
					});
			},
			function getPendingJob(jobID, cb){
				_jobID = jobID;
				connection.multi()
					.hincrby(baseName, "pending", -1)
					.hgetall(baseName + ":" + jobID)
					.del(baseName + ":" + jobID)
					.exec(function(err, result){
						if(result && result[1]){
							var job = result[1];
							cb(null, jobID, job);
						}else{
							// THIS SHOULD NOT HAPPEN
							// TODO better check here
							cb(new Error("No pending job"), null, null);
						}
					});
			},
			function executePendingJob(jobID, job, cb){
				try{
					var args = JSON.parse(job.args || "{}");

					workers[queueName](args, function(err, result){
						if(pubConn){
							pubConn.publish(baseName + ":finish:" + jobID, JSON.stringify({
								error: err,
								result: result,
								request: args
							}));
						}
						cb(null, null);
					});
				}catch(e){
					cb(e, null);
				}			
			}
		], function(err, result){
			// if(err){
			// 	console.error("Error processing worker: " + err);
			// }

			if(err){
				redis.pq.emit("failed", err, _jobID);
			}else{
				redis.pq.emit("completed", result, _jobID);
			}
			redis.pq.emit("finished", _jobID);

			--runningJobs;
			if(shouldRetry){
				popAndStartJob(queueName);
			}
		});
	}
}

var worker = module.exports = function(name, fn){
	if(!workers){
		pubConn = redis.getPublishConnection();
		subConn = redis.getSubscribeConnection();
		connection = redis.getConnection();

		subConn.on("pmessage", handleEnqueueMessage);
		subConn.psubscribe("pq:*:enqueue")

		workers = {};
	}
	workers[name] = fn;
	popAndStartJob(name);
};

worker.numberOfConcurrentJobs = 1;