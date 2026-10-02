// Deterministic public handoff artifact. Never include keys, grants or queue rows.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SERVICE } from '../src/service.mjs';
import { REPLY_QUEUE_PROCESSOR_INTERVAL_SECONDS } from '../src/reply-queue-processor.mjs';
import {
  QUEUE_PATH, QUEUE_AUDIENCE, QUEUE_PAGE_SIZE, QUEUE_SCAN_SIZE,
  QUEUE_RESULT_MAX_BYTES, QUEUE_WIRE_MAX_BYTES, QUEUE_INGEST_LIMIT,
  QUEUE_SCOPES, QUEUE_TOOLS
} from '../src/reply-queue-policy.mjs';

export function queueFrontendContract() {
  return {
    version:2,
    status:'public_candidate_default_off',
    paired_frontend_verified:false,
    endpoint:{method:'POST',path:QUEUE_PATH,audience:QUEUE_AUDIENCE,redirect:'manual',browser_origin_allowed:false},
    flags:{all:['SERVICE_ENABLED','SERVICE_QUEUE_ENABLED'],mutations_add:['SERVICE_WRITE_ENABLED'],enabled_by_this_candidate:false},
    proof:{algorithm:'ES256',key_source:'existing_initialized_owner_service_key',new_key_initialization:false,
      issuer:SERVICE.issuer,subject:SERVICE.subject,ttl_seconds:45,clock_skew_seconds:SERVICE.clockSkew,
      header_fields:['alg','typ','kid'],
      claim_fields:['iss','sub','aud','scope','iat','exp','jti','method','path','body_sha256','operation','request_id'],
      request_id:'canonical_lowercase_uuid_v4',jti:'equals_request_id',
      body_hash:'base64url_sha256_exact_utf8_compact_json_bytes',
      signature:'raw_64_byte_jose',owner_check:'existing_platform_owner_guard_and_initialized_owner_id_match'},
    rpc:{jsonrpc:'2.0',id:1,method:'tools/call',
      content_type:'application/json',accept:['application/json','text/event-stream'],
      fields:['jsonrpc','id','method','params'],params_fields:['name','arguments']},
    limits:{ingest_records_min:0,ingest_records_max:QUEUE_INGEST_LIMIT,list_items_max:QUEUE_PAGE_SIZE,
      candidates_per_scan:QUEUE_SCAN_SIZE,claim_completed_scan_held_fallback_max:1,result_utf8_bytes:QUEUE_RESULT_MAX_BYTES,wire_utf8_bytes:QUEUE_WIRE_MAX_BYTES,
      review_lease_seconds:120,approval_max_age_seconds:60,planned_reply_ttl_seconds:86400,confirmed_spacing_seconds:900},
    operating_policy:{calendar:'UTC',daily_spend_max_micro_usd:1000000,monthly_spend_max_micro_usd:5000000,
      replies_per_day_max:10,replies_per_asserted_author_per_day_max:2,total_writes_per_day_max:11,
      reply_limit_configuration:'MAX_REPLIES_DAY',reply_limit_when_unset:1,example_reply_limit:0,
      lower_configured_limits_and_remaining_allowance_apply:true,
      spending_reservations_and_uncertain_liabilities_retained:true,
      model_owns:['fresh_conversation_review','value','STOP_review','whether_and_what_to_reply'],
      code_owns:['authentication','owner_binding','claims','expiry','caps','spacing','deduplication','immutable_intents','dispatch_proofs','receipt_reconciliation']},
    scopes:QUEUE_SCOPES,
    tools:QUEUE_TOOLS,
    responses:{version:1,legacy_operations_safety:{approval_required:true,send_authorized:false},
      claim_output_extension:'reply-queue-claim-output-policy.json',send_output_contract:'reply-queue-send-output-policy.json',send_input_contract:'reply-queue-send-policy.json',
      send_bridge:'claim_then_fresh_approve_then_publish_returned_binding_or_cancel',
      held_claim_authority:['target_id','intent_key','claim_token','expected_revision'],
      held_claim_generation:'independent_of_scan_generation',
      completed_send_outputs_have_legacy_safety_fields:false,
      published_false_proves_no_dispatch:false,
      next_action_after_send:'fetch_readiness_separately',
      item_fields:['target_id','author_id','root_id','state','intent_key','intent_ref','receipt_ref','reason','due_at','source_created_at','expires_at','revision'],
      claim_additional_fields:['context_ref','context_is_untrusted','draft_present','claim_token','claim_until','approval_required','send_authorized','review_only','eligibility'],
      intent_ref:'reply-queue-intent:<intent_key>',receipt_ref:'service-write:<intent_key>',
      times:'ISO_8601_UTC_or_null_except_source_created_at_and_cursor_epoch_seconds',
      context_is_untrusted:true,request_states:['completed','indeterminate'],
      mutation_replay:'same_request_id_operation_and_exact_body_returns_original_snapshot_or_indeterminate_never_reexecutes',
      readonly_requests:'fresh_observation_not_memoized',
      readiness:{authoritative_next_wake_when:'readiness_complete_true',
        continuation_action:'continue_scan',generation_field:'queue_generation',
        multipage:'minimum_non_null_page_candidate_wake_at_across_complete_same_generation_scan',
        invalidation:'discard_aggregate_and_restart_on_restart_required_generation_change_or_failed_continuation',
        claim_restart_reason:'restart_scan',scheduled:false,wake_key:'reply-queue:<account_id>',
        processor_handoff:{task_key:'reply-queue-processor:<account_id>',interval_seconds:REPLY_QUEUE_PROCESSOR_INTERVAL_SECONDS,
          schedule_needed:'boolean_for_complete_readiness_null_for_partial_or_restart',actions:['enable','pause','continue_scan'],
          identity_fields:['task_key','queue_generation','desired_state_id','action','interval_seconds'],
          scheduled:false,registration_acknowledgement_required:true,
          desired_state_id:'deterministic_binding_of_task_key_generation_action_and_interval_null_when_incomplete',
          on_tick:'refresh_eligibility_expiry_caps_and_claim_then_fresh_model_review',
          reconciliation_module:'src/reply-queue-processor.mjs',reconciliation_export:'reconcileReplyQueueProcessor',
          reconciliation_actions:['enable','pause','inspect_scheduler','continue_scan','acknowledge_current','none'],
          acknowledgement:'owner_client_binds_verified_actual_task_id_schedule_and_desired_state_then_reconciles_fresh_readiness',
          hourly_discovery:'independent_job_resumes_processor_for_new_actionable_work',
          only_expired_unknown_or_terminal_work:'pause',
          stale_or_lost_task:'fresh_platform_lookup_before_and_after_mutation_never_trust_old_ack_alone'}}},
    expiry:{deadline:'min(original_server_first_seen,source_created_at)+86400',rescan_refresh:false,
      cleanup:'empty_or_nonempty_ingest_and_mutating_queue_processing',
      mutable_terminal_reason:'planned_reply_expired',retain:['dedup_tombstones','immutable_intents','dispatch_proofs','receipts']},
    initialization:{migrations:['0008_reply_queue.sql','0009_reply_queue_service.sql','0010_reply_queue_expiry.sql','0011_reply_queue_review.sql'],
      owner_migration_route:'/owner/maintenance/reply-queue-migrate',
      owner_migration_scope:'fixed_reviewed_schema_existing_owner_session_origin_csrf_no_caller_sql',
      state_preserving_rollback:true,
      first_mutation_binds_empty_queue:true,adopt_existing_nonempty_unbound_queue:false},
    absent_capabilities:['verified_paired_frontend_deployment','scheduler_activation','backend_callback_credential','automatic_intent_key_replacement'],
    documents:['docs/reply-queue.md']
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  writeFileSync(new URL('../../docs/reply-queue-contract.json',import.meta.url),JSON.stringify(queueFrontendContract(),null,2)+'\n');
