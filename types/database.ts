
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "access_grant_reviews": {
                  Row: {
                    "decision": string,"grant_id": string,"id": string,"note": string | null,"org_id": string,"reviewed_at": string,"reviewed_by": string
                  }
                  ComputedFields: never
                  Insert: {
                    "decision": string,"grant_id": string,"id"?: string,"note"?: string | null,"org_id": string,"reviewed_at"?: string,"reviewed_by": string
                  }
                  Update: {
                    "decision"?: string,"grant_id"?: string,"id"?: string,"note"?: string | null,"org_id"?: string,"reviewed_at"?: string,"reviewed_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "access_grant_reviews_grant_id_fkey"
      columns: ["grant_id"]
isOneToOne: false
      referencedRelation: "access_grants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "access_grant_reviews_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"access_grants": {
                  Row: {
                    "asset_id": string | null,"camera_id": string | null,"capability": string,"granted_at": string,"granted_by": string | null,"id": string,"location_id": string | null,"needs_review": boolean,"org_id": string,"reason": string | null,"revoke_reason": string | null,"revoked_at": string | null,"revoked_by": string | null,"scope_id": string | null,"scope_kind": string,"source": string,"user_id": string,"valid_from": string,"valid_until": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "asset_id"?: string | null,"camera_id"?: string | null,"capability": string,"granted_at"?: string,"granted_by"?: string | null,"id"?: string,"location_id"?: string | null,"needs_review"?: boolean,"org_id": string,"reason"?: string | null,"revoke_reason"?: string | null,"revoked_at"?: string | null,"revoked_by"?: string | null,"scope_id"?: string | null,"scope_kind": string,"source"?: string,"user_id": string,"valid_from"?: string,"valid_until"?: string | null
                  }
                  Update: {
                    "asset_id"?: string | null,"camera_id"?: string | null,"capability"?: string,"granted_at"?: string,"granted_by"?: string | null,"id"?: string,"location_id"?: string | null,"needs_review"?: boolean,"org_id"?: string,"reason"?: string | null,"revoke_reason"?: string | null,"revoked_at"?: string | null,"revoked_by"?: string | null,"scope_id"?: string | null,"scope_kind"?: string,"source"?: string,"user_id"?: string,"valid_from"?: string,"valid_until"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "access_grants_asset_fk"
      columns: ["asset_id","org_id"]
isOneToOne: false
      referencedRelation: "devices"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "access_grants_camera_fk"
      columns: ["camera_id","org_id"]
isOneToOne: false
      referencedRelation: "camera_endpoints"
      referencedColumns: ["camera_id","org_id"]
    },{
      foreignKeyName: "access_grants_camera_fk"
      columns: ["camera_id","org_id"]
isOneToOne: false
      referencedRelation: "cameras"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "access_grants_capability_fkey"
      columns: ["capability"]
isOneToOne: false
      referencedRelation: "capabilities"
      referencedColumns: ["key"]
    },{
      foreignKeyName: "access_grants_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "store_nvr_endpoints"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "access_grants_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "store_status"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "access_grants_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "access_grants_org_fk"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"access_migration_report": {
                  Row: {
                    "created_at": string,"id": string,"new_grants": NonNullable<Json>,"note": string | null,"old_model": NonNullable<Json>,"org_id": string,"run_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"new_grants": NonNullable<Json>,"note"?: string | null,"old_model": NonNullable<Json>,"org_id": string,"run_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"new_grants"?: NonNullable<Json>,"note"?: string | null,"old_model"?: NonNullable<Json>,"org_id"?: string,"run_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "access_migration_report_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"admin_audit_log": {
                  Row: {
                    "action": string,"actor_id": string | null,"created_at": string,"detail": NonNullable<Json>,"entity_id": string | null,"entity_type": string | null,"id": string,"org_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"created_at"?: string,"detail"?: NonNullable<Json>,"entity_id"?: string | null,"entity_type"?: string | null,"id"?: string,"org_id": string
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"created_at"?: string,"detail"?: NonNullable<Json>,"entity_id"?: string | null,"entity_type"?: string | null,"id"?: string,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "admin_audit_log_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"camera_group_items": {
                  Row: {
                    "added_at": string,"camera_id": string,"group_id": string,"org_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "added_at"?: string,"camera_id": string,"group_id": string,"org_id": string
                  }
                  Update: {
                    "added_at"?: string,"camera_id"?: string,"group_id"?: string,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "camera_group_items_camera_id_org_id_fkey"
      columns: ["camera_id","org_id"]
isOneToOne: false
      referencedRelation: "camera_endpoints"
      referencedColumns: ["camera_id","org_id"]
    },{
      foreignKeyName: "camera_group_items_camera_id_org_id_fkey"
      columns: ["camera_id","org_id"]
isOneToOne: false
      referencedRelation: "cameras"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "camera_group_items_group_id_org_id_fkey"
      columns: ["group_id","org_id"]
isOneToOne: false
      referencedRelation: "camera_groups"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"camera_groups": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"name": string,"org_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"name": string,"org_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"name"?: string,"org_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "camera_groups_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"cameras": {
                  Row: {
                    "camera_ip": string | null,"channel": number,"created_at": string,"id": string,"is_active": boolean,"name": string,"org_id": string,"store_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "camera_ip"?: string | null,"channel": number,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name": string,"org_id": string,"store_id": string,"updated_at"?: string
                  }
                  Update: {
                    "camera_ip"?: string | null,"channel"?: number,"created_at"?: string,"id"?: string,"is_active"?: boolean,"name"?: string,"org_id"?: string,"store_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "cameras_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cameras_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_nvr_endpoints"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "cameras_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_status"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "cameras_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"capabilities": {
                  Row: {
                    "area": string,"description": string,"key": string,"requires_mfa": boolean,"risk": string,"scope_kinds": (string)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "area": string,"description": string,"key": string,"requires_mfa": boolean,"risk": string,"scope_kinds": (string)[]
                  }
                  Update: {
                    "area"?: string,"description"?: string,"key"?: string,"requires_mfa"?: boolean,"risk"?: string,"scope_kinds"?: (string)[]
                  }
                  Relationships: [
                    
                  ]
                },"check_state": {
                  Row: {
                    "consecutive_failures": number,"created_at": string,"down_since": string | null,"error": string | null,"first_failure_at": string | null,"id": string,"last_checked_at": string | null,"last_up_at": string | null,"method": string | null,"org_id": string,"status": string,"target_id": string,"target_type": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "consecutive_failures"?: number,"created_at"?: string,"down_since"?: string | null,"error"?: string | null,"first_failure_at"?: string | null,"id"?: string,"last_checked_at"?: string | null,"last_up_at"?: string | null,"method"?: string | null,"org_id": string,"status"?: string,"target_id": string,"target_type": string,"updated_at"?: string
                  }
                  Update: {
                    "consecutive_failures"?: number,"created_at"?: string,"down_since"?: string | null,"error"?: string | null,"first_failure_at"?: string | null,"id"?: string,"last_checked_at"?: string | null,"last_up_at"?: string | null,"method"?: string | null,"org_id"?: string,"status"?: string,"target_id"?: string,"target_type"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "check_state_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"devices": {
                  Row: {
                    "created_at": string,"enabled": boolean,"id": string,"ip": string,"name": string,"notes": string | null,"org_id": string,"store_id": string | null,"tcp_port": number | null,"type": Database["public"]['Enums']["device_type"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"enabled"?: boolean,"id"?: string,"ip": string,"name": string,"notes"?: string | null,"org_id": string,"store_id"?: string | null,"tcp_port"?: number | null,"type": Database["public"]['Enums']["device_type"],"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"enabled"?: boolean,"id"?: string,"ip"?: string,"name"?: string,"notes"?: string | null,"org_id"?: string,"store_id"?: string | null,"tcp_port"?: number | null,"type"?: Database["public"]['Enums']["device_type"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "devices_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "devices_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_nvr_endpoints"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "devices_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_status"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "devices_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"monitor_gaps": {
                  Row: {
                    "ended_at": string,"id": string,"started_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "ended_at": string,"id"?: string,"started_at": string
                  }
                  Update: {
                    "ended_at"?: string,"id"?: string,"started_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"organizations": {
                  Row: {
                    "created_at": string,"id": string,"is_owner": boolean,"name": string,"slug": string,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_owner"?: boolean,"name": string,"slug": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_owner"?: boolean,"name"?: string,"slug"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"outages": {
                  Row: {
                    "cause": string | null,"created_at": string,"ended_at": string | null,"id": string,"org_id": string,"started_at": string,"target_id": string,"target_type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "cause"?: string | null,"created_at"?: string,"ended_at"?: string | null,"id"?: string,"org_id": string,"started_at": string,"target_id": string,"target_type": string
                  }
                  Update: {
                    "cause"?: string | null,"created_at"?: string,"ended_at"?: string | null,"id"?: string,"org_id"?: string,"started_at"?: string,"target_id"?: string,"target_type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outages_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "access_version": number,"created_at": string,"email": string,"full_name": string,"id": string,"is_active": boolean,"must_reset_password": boolean,"org_id": string,"role": Database["public"]['Enums']["user_role"],"store_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "access_version"?: number,"created_at"?: string,"email": string,"full_name"?: string,"id": string,"is_active"?: boolean,"must_reset_password"?: boolean,"org_id": string,"role"?: Database["public"]['Enums']["user_role"],"store_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "access_version"?: number,"created_at"?: string,"email"?: string,"full_name"?: string,"id"?: string,"is_active"?: boolean,"must_reset_password"?: boolean,"org_id"?: string,"role"?: Database["public"]['Enums']["user_role"],"store_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "profiles_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "profiles_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_nvr_endpoints"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "profiles_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_status"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "profiles_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"stores": {
                  Row: {
                    "address": string | null,"city": string | null,"code": string,"created_at": string,"expected_channels": number,"http_port": number,"id": string,"is_active": boolean,"name": string,"nvr_ip": string,"nvr_secret_id": string | null,"nvr_username": string,"org_id": string,"rtsp_port": number,"state": string | null,"updated_at": string,"zone": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"city"?: string | null,"code": string,"created_at"?: string,"expected_channels"?: number,"http_port"?: number,"id"?: string,"is_active"?: boolean,"name": string,"nvr_ip": string,"nvr_secret_id"?: string | null,"nvr_username": string,"org_id": string,"rtsp_port"?: number,"state"?: string | null,"updated_at"?: string,"zone"?: string | null
                  }
                  Update: {
                    "address"?: string | null,"city"?: string | null,"code"?: string,"created_at"?: string,"expected_channels"?: number,"http_port"?: number,"id"?: string,"is_active"?: boolean,"name"?: string,"nvr_ip"?: string,"nvr_secret_id"?: string | null,"nvr_username"?: string,"org_id"?: string,"rtsp_port"?: number,"state"?: string | null,"updated_at"?: string,"zone"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "stores_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"user_camera_access": {
                  Row: {
                    "camera_id": string,"org_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "camera_id": string,"org_id": string,"user_id": string
                  }
                  Update: {
                    "camera_id"?: string,"org_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_camera_access_camera_id_org_id_fkey"
      columns: ["camera_id","org_id"]
isOneToOne: false
      referencedRelation: "camera_endpoints"
      referencedColumns: ["camera_id","org_id"]
    },{
      foreignKeyName: "user_camera_access_camera_id_org_id_fkey"
      columns: ["camera_id","org_id"]
isOneToOne: false
      referencedRelation: "cameras"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "user_camera_access_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "user_camera_access_user_id_org_id_fkey"
      columns: ["user_id","org_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"user_store_access": {
                  Row: {
                    "org_id": string,"store_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "org_id": string,"store_id": string,"user_id": string
                  }
                  Update: {
                    "org_id"?: string,"store_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_store_access_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "user_store_access_store_id_org_id_fkey"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_nvr_endpoints"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "user_store_access_store_id_org_id_fkey"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_status"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "user_store_access_store_id_org_id_fkey"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "user_store_access_user_id_org_id_fkey"
      columns: ["user_id","org_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"user_zone_access": {
                  Row: {
                    "org_id": string,"user_id": string,"zone": string
                  }
                  ComputedFields: never
                  Insert: {
                    "org_id": string,"user_id": string,"zone": string
                  }
                  Update: {
                    "org_id"?: string,"user_id"?: string,"zone"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "user_zone_access_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "user_zone_access_user_id_org_id_fkey"
      columns: ["user_id","org_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"worker_state": {
                  Row: {
                    "check_requested_at": string | null,"id": number,"last_cameras_round_at": string | null,"last_devices_round_at": string | null,"last_heartbeat": string | null,"progress_done": number,"progress_total": number,"run_finished_at": string | null,"run_started_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "check_requested_at"?: string | null,"id": number,"last_cameras_round_at"?: string | null,"last_devices_round_at"?: string | null,"last_heartbeat"?: string | null,"progress_done"?: number,"progress_total"?: number,"run_finished_at"?: string | null,"run_started_at"?: string | null
                  }
                  Update: {
                    "check_requested_at"?: string | null,"id"?: number,"last_cameras_round_at"?: string | null,"last_devices_round_at"?: string | null,"last_heartbeat"?: string | null,"progress_done"?: number,"progress_total"?: number,"run_finished_at"?: string | null,"run_started_at"?: string | null
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "camera_endpoints": {
                  Row: {
                    "camera_id": string | null,"camera_ip": string | null,"org_id": string | null,"store_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                           "camera_id"?: string | null,"camera_ip"?: string | null,"org_id"?: string | null,"store_id"?: string | null
                         }
                        Update: {
                           "camera_id"?: string | null,"camera_ip"?: string | null,"org_id"?: string | null,"store_id"?: string | null
                         }
                        Relationships: [
                    {
      foreignKeyName: "cameras_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cameras_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_nvr_endpoints"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "cameras_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "store_status"
      referencedColumns: ["store_id","org_id"]
    },{
      foreignKeyName: "cameras_store_fk"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"store_nvr_endpoints": {
                  Row: {
                    "http_port": number | null,"nvr_ip": string | null,"nvr_username": string | null,"org_id": string | null,"rtsp_port": number | null,"store_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                           "http_port"?: number | null,"nvr_ip"?: string | null,"nvr_username"?: string | null,"org_id"?: string | null,"rtsp_port"?: number | null,"store_id"?: string | null
                         }
                        Update: {
                           "http_port"?: number | null,"nvr_ip"?: string | null,"nvr_username"?: string | null,"org_id"?: string | null,"rtsp_port"?: number | null,"store_id"?: string | null
                         }
                        Relationships: [
                    {
      foreignKeyName: "stores_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"store_status": {
                  Row: {
                    "cameras_down": number | null,"cameras_live": number | null,"cameras_stale": number | null,"cameras_total": number | null,"cameras_unknown": number | null,"nvr_checked_at": string | null,"nvr_down_since": string | null,"nvr_stale": boolean | null,"nvr_status": string | null,"org_id": string | null,"store_id": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "stores_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "access_aal2_of":
{ Args: { "p_claims": Json }; Returns: boolean
                           },
"access_bump_version":
{ Args: { "p_user": string }; Returns: number
                           },
"access_caller_aal2":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"access_camera_set":
{ Args: { "p_cameras": (string)[],"p_locations": (string)[],"p_org": string,"p_org_wide": boolean }; Returns: string[]
                           },
"access_cameras_for":
{ Args: { "p_aal2": boolean,"p_at": string,"p_caps": (string)[],"p_ignore_status": boolean,"p_user": string }; Returns: string[]
                           },
"access_catalogue_probe_test":
{ Args: { "p_org": string }; Returns: Json
                           },
"access_check_actor":
{ Args: { "p_actor": string,"p_org": string }; Returns: undefined
                           },
"access_check_grantor":
{ Args: { "p_actor": string,"p_org": string,"p_reason": string,"p_spec": Json,"p_user": string }; Returns: undefined
                           },
"access_check_manager":
{ Args: { "p_actor": string,"p_org": string,"p_user": string }; Returns: Database["public"]['Enums']["user_role"]
                           },
"access_check_spec":
{ Args: { "p_org": string,"p_spec": Json }; Returns: undefined
                           },
"access_device_set":
{ Args: { "p_assets": (string)[],"p_locations": (string)[],"p_org": string,"p_org_wide": boolean }; Returns: string[]
                           },
"access_devices_for":
{ Args: { "p_aal2": boolean,"p_at": string,"p_caps": (string)[],"p_ignore_status": boolean,"p_user": string }; Returns: string[]
                           },
"access_expiring":
{ Args: { "p_org": string,"p_within": string }; Returns: {
              "capability": string,"grant_id": string,"org_id": string,"scope_id": string,"scope_kind": string,"user_id": string,"valid_until": string
            }[]
                           },
"access_grant_summary":
{ Args: { "p_org": string }; Returns: {
              "assets": number,"cameras": number,"capability": string,"locations": number,"next_expiry": string,"organization_wide": boolean,"user_id": string
            }[]
                           },
"access_grants_eval":
{ Args: { "p_aal2": boolean,"p_at": string,"p_ignore_status": boolean,"p_mfa_enforced": boolean,"p_user": string }; Returns: {
              "area": string,"capability": string,"org_id": string,"scope_id": string,"scope_kind": string
            }[]
                           },
"access_grants_of":
{ Args: { "p_aal2": boolean,"p_at": string,"p_ignore_status": boolean,"p_user": string }; Returns: {
              "area": string,"capability": string,"org_id": string,"scope_id": string,"scope_kind": string
            }[]
                           },
"access_items":
{ Args: { "p_at": string,"p_cap": string,"p_org": string,"p_specs": Json }; Returns: {
              "item_id": string,"label": string
            }[]
                           },
"access_legacy_camera_ids":
{ Args: { "p_ignore_status"?: boolean,"p_user": string }; Returns: string[]
                           },
"access_legacy_device_ids":
{ Args: { "p_ignore_status"?: boolean,"p_user": string }; Returns: string[]
                           },
"access_legacy_store_grants":
{ Args: { "p_ignore_status": boolean,"p_user": string }; Returns: string[]
                           },
"access_legacy_store_ids":
{ Args: { "p_ignore_status"?: boolean,"p_user": string }; Returns: string[]
                           },
"access_lock_person":
{ Args: { "p_expected": number,"p_org": string,"p_user": string }; Returns: number
                           },
"access_merge_window":
{ Args: { "p_new_from": string,"p_new_until": string,"p_old_from": string,"p_old_until": string }; Returns: Record<string, unknown>
                           },
"access_migrate_legacy":
{ Args: { "p_force"?: boolean,"p_run": string,"p_users"?: (string)[] }; Returns: number
                           },
"access_migrate_legacy_test":
{ Args: { "p_force"?: boolean,"p_run": string,"p_users"?: (string)[] }; Returns: number
                           },
"access_put_grant":
{ Args: { "p_actor": string,"p_needs_review": boolean,"p_org": string,"p_reason": string,"p_source": string,"p_spec": Json,"p_user": string }; Returns: Record<string, unknown>
                           },
"access_review_keep":
{ Args: { "p_actor": string,"p_grant_ids": (string)[],"p_note"?: string,"p_org": string }; Returns: number
                           },
"access_session_capabilities":
{ Args: { "p_claims": Json,"p_mfa_enforced": boolean,"p_user": string }; Returns: string[]
                           },
"access_store_set":
{ Args: { "p_locations": (string)[],"p_org": string,"p_org_wide": boolean }; Returns: string[]
                           },
"access_stores_for":
{ Args: { "p_aal2": boolean,"p_at": string,"p_caps": (string)[],"p_ignore_status": boolean,"p_user": string }; Returns: string[]
                           },
"any_cctv_camera_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"any_grant_store_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"apply_access_change":
{ Args: { "p_actor": string,"p_changes": Json,"p_expected_version"?: number,"p_org": string,"p_user": string }; Returns: Json
                           },
"cameras_with_capability":
{ Args: { "p_cap": string,"p_ids": (string)[] }; Returns: string[]
                           },
"capability_camera_ids":
{ Args: { "p_cap": string }; Returns: string[]
                           },
"capability_device_ids":
{ Args: { "p_cap": string }; Returns: string[]
                           },
"capability_store_ids":
{ Args: { "p_cap": string }; Returns: string[]
                           },
"cctv_visible_group_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"current_org_id":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"current_user_role":
{ Args: Record<PropertyKey, never>; Returns: Database["public"]['Enums']["user_role"]
                           },
"function_privileges":
{ Args: Record<PropertyKey, never>; Returns: {
              "args": string,"grantees": (string)[],"name": string,"search_path": string,"security_definer": boolean
            }[]
                           },
"grant_access":
{ Args: { "p_actor"?: string,"p_expected_version"?: number,"p_grants": Json,"p_org": string,"p_reason"?: string,"p_user": string }; Returns: Json
                           },
"grant_platform_owner_all":
{ Args: { "p_org": string,"p_user": string }; Returns: number
                           },
"has_capability":
{ Args: { "p_cap": string }; Returns: boolean
                           },
"has_capability_for":
{ Args: { "p_cap": string,"p_id": string,"p_kind": string }; Returns: boolean
                           },
"it_view_device_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"it_view_store_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"mfa_enforced":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"monitor_apply_results":
{ Args: { "p_org": string,"p_results": Json,"p_threshold"?: number }; Returns: undefined
                           },
"monitor_request_check":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"monitor_stale_after_minutes":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"monitor_stop_targets":
{ Args: { "p_ids": (string)[],"p_org": string,"p_type": string }; Returns: undefined
                           },
"my_access_summary":
{ Args: Record<PropertyKey, never>; Returns: {
              "asset_ids": (string)[],"camera_ids": (string)[],"capability": string,"location_ids": (string)[],"organization_wide": boolean
            }[]
                           },
"nvr_delete_credential":
{ Args: { "p_store": string }; Returns: undefined
                           },
"nvr_read_credential":
{ Args: { "p_store": string }; Returns: string
                           },
"nvr_store_credential":
{ Args: { "p_secret": string,"p_store": string }; Returns: string
                           },
"preview_access_change":
{ Args: { "p_at"?: string,"p_changes": Json,"p_org": string,"p_sample"?: number,"p_user": string }; Returns: Json
                           },
"privilege_violations":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"replace_user_grants":
{ Args: { "p_actor"?: string,"p_capabilities": (string)[],"p_expected_version"?: number,"p_grants": Json,"p_org": string,"p_reason"?: string,"p_scope_kinds": (string)[],"p_user": string }; Returns: Json
                           },
"report_effective_camera_ids":
{ Args: { "p_at"?: string,"p_cap": string,"p_ignore_status"?: boolean,"p_user": string }; Returns: string[]
                           },
"report_effective_device_ids":
{ Args: { "p_at"?: string,"p_cap": string,"p_ignore_status"?: boolean,"p_user": string }; Returns: string[]
                           },
"revoke_grant":
{ Args: { "p_actor"?: string,"p_expected_version"?: number,"p_grant_ids": (string)[],"p_org": string,"p_reason"?: string,"p_user": string }; Returns: Json
                           },
"revoke_user_sessions":
{ Args: { "p_user": string }; Returns: undefined
                           },
"status_reasons":
{ Args: { "p_ids": (string)[],"p_type": string }; Returns: {
              "reason": string,"target_id": string
            }[]
                           },
"targets_uptime":
{ Args: { "p_ids": (string)[],"p_now"?: string,"p_org": string,"p_type": string,"p_window": string }; Returns: {
              "target_id": string,"uptime_pct": number
            }[]
                           }
          }
          Enums: {
            "device_type": "nvr"|"server"|"attendance"|"footfall"|"other","user_role": "user"|"operator"|"manager"|"admin"|"platform_owner"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "device_type": ["nvr", "server", "attendance", "footfall", "other"],"user_role": ["user", "operator", "manager", "admin", "platform_owner"]
          }
        }
} as const
