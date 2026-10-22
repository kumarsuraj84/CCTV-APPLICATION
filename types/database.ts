
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
                    "asset_id": string | null,"camera_id": string | null,"capability": string,"cluster_id": string | null,"granted_at": string,"granted_by": string | null,"id": string,"location_id": string | null,"needs_review": boolean,"org_id": string,"reason": string | null,"recorder_id": string | null,"region_id": string | null,"revoke_reason": string | null,"revoked_at": string | null,"revoked_by": string | null,"scope_id": string | null,"scope_kind": string,"source": string,"user_id": string,"valid_from": string,"valid_until": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "asset_id"?: string | null,"camera_id"?: string | null,"capability": string,"cluster_id"?: string | null,"granted_at"?: string,"granted_by"?: string | null,"id"?: string,"location_id"?: string | null,"needs_review"?: boolean,"org_id": string,"reason"?: string | null,"recorder_id"?: string | null,"region_id"?: string | null,"revoke_reason"?: string | null,"revoked_at"?: string | null,"revoked_by"?: string | null,"scope_id"?: string | null,"scope_kind": string,"source"?: string,"user_id": string,"valid_from"?: string,"valid_until"?: string | null
                  }
                  Update: {
                    "asset_id"?: string | null,"camera_id"?: string | null,"capability"?: string,"cluster_id"?: string | null,"granted_at"?: string,"granted_by"?: string | null,"id"?: string,"location_id"?: string | null,"needs_review"?: boolean,"org_id"?: string,"reason"?: string | null,"recorder_id"?: string | null,"region_id"?: string | null,"revoke_reason"?: string | null,"revoked_at"?: string | null,"revoked_by"?: string | null,"scope_id"?: string | null,"scope_kind"?: string,"source"?: string,"user_id"?: string,"valid_from"?: string,"valid_until"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "access_grants_asset_fk"
      columns: ["asset_id","org_id"]
isOneToOne: false
      referencedRelation: "assets"
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
      foreignKeyName: "access_grants_cluster_fk"
      columns: ["cluster_id","org_id"]
isOneToOne: false
      referencedRelation: "clusters"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "access_grants_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_hierarchy"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "access_grants_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_status"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "access_grants_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "access_grants_org_fk"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "access_grants_recorder_fk"
      columns: ["recorder_id","org_id"]
isOneToOne: false
      referencedRelation: "recorder_endpoints"
      referencedColumns: ["recorder_id","org_id"]
    },{
      foreignKeyName: "access_grants_recorder_fk"
      columns: ["recorder_id","org_id"]
isOneToOne: false
      referencedRelation: "recorder_status"
      referencedColumns: ["recorder_id","org_id"]
    },{
      foreignKeyName: "access_grants_recorder_fk"
      columns: ["recorder_id","org_id"]
isOneToOne: false
      referencedRelation: "recorders"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "access_grants_region_fk"
      columns: ["region_id","org_id"]
isOneToOne: false
      referencedRelation: "regions"
      referencedColumns: ["id","org_id"]
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
                },"address_spaces": {
                  Row: {
                    "created_at": string,"id": string,"kind": string,"location_id": string | null,"name": string,"notes": string | null,"org_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"kind": string,"location_id"?: string | null,"name": string,"notes"?: string | null,"org_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"kind"?: string,"location_id"?: string | null,"name"?: string,"notes"?: string | null,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "address_spaces_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_hierarchy"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "address_spaces_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_status"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "address_spaces_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "address_spaces_org_id_fkey"
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
                },"asset_dependencies": {
                  Row: {
                    "child_asset_id": string,"created_at": string,"id": string,"kind": string,"org_id": string,"parent_asset_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "child_asset_id": string,"created_at"?: string,"id"?: string,"kind": string,"org_id": string,"parent_asset_id": string
                  }
                  Update: {
                    "child_asset_id"?: string,"created_at"?: string,"id"?: string,"kind"?: string,"org_id"?: string,"parent_asset_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "asset_dependencies_child_fk"
      columns: ["child_asset_id","org_id"]
isOneToOne: false
      referencedRelation: "assets"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "asset_dependencies_parent_fk"
      columns: ["parent_asset_id","org_id"]
isOneToOne: false
      referencedRelation: "assets"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"asset_endpoints": {
                  Row: {
                    "address_space_id": string,"asset_id": string,"created_at": string,"host": string,"id": string,"org_id": string,"port": number | null,"purpose": string,"retired_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "address_space_id": string,"asset_id": string,"created_at"?: string,"host": string,"id"?: string,"org_id": string,"port"?: number | null,"purpose": string,"retired_at"?: string | null
                  }
                  Update: {
                    "address_space_id"?: string,"asset_id"?: string,"created_at"?: string,"host"?: string,"id"?: string,"org_id"?: string,"port"?: number | null,"purpose"?: string,"retired_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "asset_endpoints_asset_fk"
      columns: ["asset_id","org_id"]
isOneToOne: false
      referencedRelation: "assets"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "asset_endpoints_space_fk"
      columns: ["address_space_id","org_id"]
isOneToOne: false
      referencedRelation: "address_spaces"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"assets": {
                  Row: {
                    "address_space_id": string | null,"archived_at": string | null,"archived_was_enabled": boolean | null,"assigned_profile_id": string | null,"attached_recorder_id": string | null,"capability_discovered_at": string | null,"config_owner": string | null,"created_at": string,"credential_ref": string | null,"criticality": string | null,"enabled": boolean,"firmware": string | null,"id": string,"ip": string | null,"is_recorder": boolean,"last_inventory_at": string | null,"lifecycle_state": string,"location_id": string | null,"mac": string | null,"management_mode": string | null,"model": string | null,"name": string,"notes": string | null,"org_id": string,"owner": string | null,"role": string | null,"serial": string | null,"tcp_port": number | null,"type": Database["public"]['Enums']["device_type"],"updated_at": string,"vendor": string | null,"warranty_until": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "address_space_id"?: string | null,"archived_at"?: string | null,"archived_was_enabled"?: boolean | null,"assigned_profile_id"?: string | null,"attached_recorder_id"?: string | null,"capability_discovered_at"?: string | null,"config_owner"?: string | null,"created_at"?: string,"credential_ref"?: string | null,"criticality"?: string | null,"enabled"?: boolean,"firmware"?: string | null,"id"?: string,"ip"?: string | null,"is_recorder"?: boolean,"last_inventory_at"?: string | null,"lifecycle_state"?: string,"location_id"?: string | null,"mac"?: string | null,"management_mode"?: string | null,"model"?: string | null,"name": string,"notes"?: string | null,"org_id": string,"owner"?: string | null,"role"?: string | null,"serial"?: string | null,"tcp_port"?: number | null,"type": Database["public"]['Enums']["device_type"],"updated_at"?: string,"vendor"?: string | null,"warranty_until"?: string | null
                  }
                  Update: {
                    "address_space_id"?: string | null,"archived_at"?: string | null,"archived_was_enabled"?: boolean | null,"assigned_profile_id"?: string | null,"attached_recorder_id"?: string | null,"capability_discovered_at"?: string | null,"config_owner"?: string | null,"created_at"?: string,"credential_ref"?: string | null,"criticality"?: string | null,"enabled"?: boolean,"firmware"?: string | null,"id"?: string,"ip"?: string | null,"is_recorder"?: boolean,"last_inventory_at"?: string | null,"lifecycle_state"?: string,"location_id"?: string | null,"mac"?: string | null,"management_mode"?: string | null,"model"?: string | null,"name"?: string,"notes"?: string | null,"org_id"?: string,"owner"?: string | null,"role"?: string | null,"serial"?: string | null,"tcp_port"?: number | null,"type"?: Database["public"]['Enums']["device_type"],"updated_at"?: string,"vendor"?: string | null,"warranty_until"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "assets_attached_recorder_fk"
      columns: ["attached_recorder_id","org_id"]
isOneToOne: false
      referencedRelation: "recorder_endpoints"
      referencedColumns: ["recorder_id","org_id"]
    },{
      foreignKeyName: "assets_attached_recorder_fk"
      columns: ["attached_recorder_id","org_id"]
isOneToOne: false
      referencedRelation: "recorder_status"
      referencedColumns: ["recorder_id","org_id"]
    },{
      foreignKeyName: "assets_attached_recorder_fk"
      columns: ["attached_recorder_id","org_id"]
isOneToOne: false
      referencedRelation: "recorders"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "assets_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_hierarchy"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "assets_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_status"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "assets_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "assets_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "assets_space_fk"
      columns: ["address_space_id","org_id"]
isOneToOne: false
      referencedRelation: "address_spaces"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"camera_channel_mappings": {
                  Row: {
                    "camera_id": string,"channel": number,"created_at": string,"created_by": string | null,"id": string,"org_id": string,"recorder_id": string,"valid_from": string,"valid_to": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "camera_id": string,"channel": number,"created_at"?: string,"created_by"?: string | null,"id"?: string,"org_id": string,"recorder_id": string,"valid_from"?: string,"valid_to"?: string | null
                  }
                  Update: {
                    "camera_id"?: string,"channel"?: number,"created_at"?: string,"created_by"?: string | null,"id"?: string,"org_id"?: string,"recorder_id"?: string,"valid_from"?: string,"valid_to"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "camera_channel_mappings_camera_fk"
      columns: ["camera_id","org_id"]
isOneToOne: false
      referencedRelation: "camera_endpoints"
      referencedColumns: ["camera_id","org_id"]
    },{
      foreignKeyName: "camera_channel_mappings_camera_fk"
      columns: ["camera_id","org_id"]
isOneToOne: false
      referencedRelation: "cameras"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "camera_channel_mappings_recorder_fk"
      columns: ["recorder_id","org_id"]
isOneToOne: false
      referencedRelation: "recorder_endpoints"
      referencedColumns: ["recorder_id","org_id"]
    },{
      foreignKeyName: "camera_channel_mappings_recorder_fk"
      columns: ["recorder_id","org_id"]
isOneToOne: false
      referencedRelation: "recorder_status"
      referencedColumns: ["recorder_id","org_id"]
    },{
      foreignKeyName: "camera_channel_mappings_recorder_fk"
      columns: ["recorder_id","org_id"]
isOneToOne: false
      referencedRelation: "recorders"
      referencedColumns: ["id","org_id"]
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
                },"camera_group_rules": {
                  Row: {
                    "created_at": string,"created_by": string | null,"group_id": string,"id": string,"kind": string,"name_contains": string | null,"org_id": string,"ref_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"group_id": string,"id"?: string,"kind": string,"name_contains"?: string | null,"org_id": string,"ref_id"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"group_id"?: string,"id"?: string,"kind"?: string,"name_contains"?: string | null,"org_id"?: string,"ref_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "camera_group_rules_group_id_org_id_fkey"
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
                    "archived_at": string | null,"archived_was_active": boolean | null,"camera_ip": string | null,"channel": number,"created_at": string,"id": string,"is_active": boolean,"location_id": string,"name": string,"org_id": string,"recorder_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"archived_was_active"?: boolean | null,"camera_ip"?: string | null,"channel": number,"created_at"?: string,"id"?: string,"is_active"?: boolean,"location_id": string,"name": string,"org_id": string,"recorder_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"archived_was_active"?: boolean | null,"camera_ip"?: string | null,"channel"?: number,"created_at"?: string,"id"?: string,"is_active"?: boolean,"location_id"?: string,"name"?: string,"org_id"?: string,"recorder_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "cameras_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_hierarchy"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "cameras_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_status"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "cameras_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "cameras_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cameras_recorder_fk"
      columns: ["recorder_id","org_id"]
isOneToOne: false
      referencedRelation: "recorder_endpoints"
      referencedColumns: ["recorder_id","org_id"]
    },{
      foreignKeyName: "cameras_recorder_fk"
      columns: ["recorder_id","org_id"]
isOneToOne: false
      referencedRelation: "recorder_status"
      referencedColumns: ["recorder_id","org_id"]
    },{
      foreignKeyName: "cameras_recorder_fk"
      columns: ["recorder_id","org_id"]
isOneToOne: false
      referencedRelation: "recorders"
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
                },"clusters": {
                  Row: {
                    "archived_at": string | null,"code": string,"created_at": string,"id": string,"name": string,"org_id": string,"region_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"code": string,"created_at"?: string,"id"?: string,"name": string,"org_id": string,"region_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"code"?: string,"created_at"?: string,"id"?: string,"name"?: string,"org_id"?: string,"region_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "clusters_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "clusters_region_fk"
      columns: ["region_id","org_id"]
isOneToOne: false
      referencedRelation: "regions"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"device_capabilities": {
                  Row: {
                    "adapter_state": string,"created_at": string,"firmware_max": string | null,"firmware_min": string | null,"id": string,"management_mode": string,"model": string,"notes": string | null,"operation": string,"source_ref": string,"support": string,"vendor": string,"verified_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "adapter_state"?: string,"created_at"?: string,"firmware_max"?: string | null,"firmware_min"?: string | null,"id"?: string,"management_mode": string,"model": string,"notes"?: string | null,"operation": string,"source_ref": string,"support": string,"vendor": string,"verified_at"?: string | null
                  }
                  Update: {
                    "adapter_state"?: string,"created_at"?: string,"firmware_max"?: string | null,"firmware_min"?: string | null,"id"?: string,"management_mode"?: string,"model"?: string,"notes"?: string | null,"operation"?: string,"source_ref"?: string,"support"?: string,"vendor"?: string,"verified_at"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"discovery_findings": {
                  Row: {
                    "because": string | null,"camera_id": string,"channel": number | null,"found_at": string,"found_by": string | null,"id": string,"kind": string,"location_id": string,"note": string | null,"org_id": string,"other_camera_id": string | null,"recorder_id": string,"reported_name": string | null,"resolution": string | null,"resolved_at": string | null,"resolved_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "because"?: string | null,"camera_id": string,"channel"?: number | null,"found_at"?: string,"found_by"?: string | null,"id"?: string,"kind": string,"location_id": string,"note"?: string | null,"org_id": string,"other_camera_id"?: string | null,"recorder_id": string,"reported_name"?: string | null,"resolution"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null
                  }
                  Update: {
                    "because"?: string | null,"camera_id"?: string,"channel"?: number | null,"found_at"?: string,"found_by"?: string | null,"id"?: string,"kind"?: string,"location_id"?: string,"note"?: string | null,"org_id"?: string,"other_camera_id"?: string | null,"recorder_id"?: string,"reported_name"?: string | null,"resolution"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "discovery_findings_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"inventory_migration_report": {
                  Row: {
                    "detail": NonNullable<Json>,"id": string,"kind": string,"location_id": string | null,"org_id": string,"recorder_id": string | null,"run_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "detail"?: NonNullable<Json>,"id"?: string,"kind": string,"location_id"?: string | null,"org_id": string,"recorder_id"?: string | null,"run_at"?: string
                  }
                  Update: {
                    "detail"?: NonNullable<Json>,"id"?: string,"kind"?: string,"location_id"?: string | null,"org_id"?: string,"recorder_id"?: string | null,"run_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "inventory_migration_report_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"locations": {
                  Row: {
                    "address": string | null,"archived_at": string | null,"archived_was_active": boolean | null,"city": string | null,"cluster_id": string | null,"code": string,"created_at": string,"id": string,"is_active": boolean,"kind": string,"name": string,"org_id": string,"parent_location_id": string | null,"state": string | null,"updated_at": string,"uplink_asset_id": string | null,"zone": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"archived_at"?: string | null,"archived_was_active"?: boolean | null,"city"?: string | null,"cluster_id"?: string | null,"code": string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"kind"?: string,"name": string,"org_id": string,"parent_location_id"?: string | null,"state"?: string | null,"updated_at"?: string,"uplink_asset_id"?: string | null,"zone"?: string | null
                  }
                  Update: {
                    "address"?: string | null,"archived_at"?: string | null,"archived_was_active"?: boolean | null,"city"?: string | null,"cluster_id"?: string | null,"code"?: string,"created_at"?: string,"id"?: string,"is_active"?: boolean,"kind"?: string,"name"?: string,"org_id"?: string,"parent_location_id"?: string | null,"state"?: string | null,"updated_at"?: string,"uplink_asset_id"?: string | null,"zone"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "locations_cluster_fk"
      columns: ["cluster_id","org_id"]
isOneToOne: false
      referencedRelation: "clusters"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "locations_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "locations_parent_fk"
      columns: ["parent_location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_hierarchy"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "locations_parent_fk"
      columns: ["parent_location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_status"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "locations_parent_fk"
      columns: ["parent_location_id","org_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "locations_uplink_fk"
      columns: ["uplink_asset_id","org_id"]
isOneToOne: false
      referencedRelation: "assets"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"media_sessions": {
                  Row: {
                    "aal2": boolean,"asset_id": string | null,"camera_id": string | null,"capability": string,"closed_at": string | null,"connect_by": string,"created_at": string,"expires_at": string,"id": string,"kind": string,"last_validated_at": string | null,"open_count": number,"opened_at": string | null,"org_id": string,"revoke_reason": string | null,"revoked_at": string | null,"stream": string | null,"user_id": string,"media_session_problem": string | null
                  }
                  ComputedFields: "media_session_problem"
                  Insert: {
                    "aal2"?: boolean,"asset_id"?: string | null,"camera_id"?: string | null,"capability": string,"closed_at"?: string | null,"connect_by": string,"created_at"?: string,"expires_at": string,"id"?: string,"kind": string,"last_validated_at"?: string | null,"open_count"?: number,"opened_at"?: string | null,"org_id": string,"revoke_reason"?: string | null,"revoked_at"?: string | null,"stream"?: string | null,"user_id": string
                  }
                  Update: {
                    "aal2"?: boolean,"asset_id"?: string | null,"camera_id"?: string | null,"capability"?: string,"closed_at"?: string | null,"connect_by"?: string,"created_at"?: string,"expires_at"?: string,"id"?: string,"kind"?: string,"last_validated_at"?: string | null,"open_count"?: number,"opened_at"?: string | null,"org_id"?: string,"revoke_reason"?: string | null,"revoked_at"?: string | null,"stream"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "media_sessions_capability_fkey"
      columns: ["capability"]
isOneToOne: false
      referencedRelation: "capabilities"
      referencedColumns: ["key"]
    },{
      foreignKeyName: "media_sessions_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "media_sessions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
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
                },"network_definitions": {
                  Row: {
                    "created_at": string,"discovery_ranges": (unknown)[],"dns": (unknown)[],"gateway": unknown,"id": string,"location_id": string,"management_cidr": unknown,"management_vlan": number | null,"org_id": string,"sdwan_context": string | null,"updated_at": string,"vlan_map": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"discovery_ranges"?: (unknown)[],"dns"?: (unknown)[],"gateway"?: unknown,"id"?: string,"location_id": string,"management_cidr": unknown,"management_vlan"?: number | null,"org_id": string,"sdwan_context"?: string | null,"updated_at"?: string,"vlan_map"?: NonNullable<Json>
                  }
                  Update: {
                    "created_at"?: string,"discovery_ranges"?: (unknown)[],"dns"?: (unknown)[],"gateway"?: unknown,"id"?: string,"location_id"?: string,"management_cidr"?: unknown,"management_vlan"?: number | null,"org_id"?: string,"sdwan_context"?: string | null,"updated_at"?: string,"vlan_map"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "network_definitions_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_hierarchy"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "network_definitions_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_status"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "network_definitions_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id","org_id"]
    }
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
                    "access_version": number,"created_at": string,"email": string,"full_name": string,"id": string,"is_active": boolean,"location_id": string | null,"must_reset_password": boolean,"org_id": string,"role": Database["public"]['Enums']["user_role"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "access_version"?: number,"created_at"?: string,"email": string,"full_name"?: string,"id": string,"is_active"?: boolean,"location_id"?: string | null,"must_reset_password"?: boolean,"org_id": string,"role"?: Database["public"]['Enums']["user_role"],"updated_at"?: string
                  }
                  Update: {
                    "access_version"?: number,"created_at"?: string,"email"?: string,"full_name"?: string,"id"?: string,"is_active"?: boolean,"location_id"?: string | null,"must_reset_password"?: boolean,"org_id"?: string,"role"?: Database["public"]['Enums']["user_role"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "profiles_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_hierarchy"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "profiles_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_status"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "profiles_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "profiles_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"recorders": {
                  Row: {
                    "clock_offset_sec": number | null,"clock_offset_source": string | null,"created_asset": boolean,"created_at": string,"expected_channels": number,"http_port": number,"id": string,"location_id": string,"migrated_from_location_id": string | null,"monitoring_disabled_at": string | null,"monitoring_disabled_by": string | null,"monitoring_disabled_reason": string | null,"monitoring_enabled": boolean,"org_id": string,"rtsp_port": number,"secret_id": string | null,"updated_at": string,"username": string | null,"vendor_capabilities": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "clock_offset_sec"?: number | null,"clock_offset_source"?: string | null,"created_asset"?: boolean,"created_at"?: string,"expected_channels"?: number,"http_port"?: number,"id": string,"location_id": string,"migrated_from_location_id"?: string | null,"monitoring_disabled_at"?: string | null,"monitoring_disabled_by"?: string | null,"monitoring_disabled_reason"?: string | null,"monitoring_enabled"?: boolean,"org_id": string,"rtsp_port"?: number,"secret_id"?: string | null,"updated_at"?: string,"username"?: string | null,"vendor_capabilities"?: NonNullable<Json>
                  }
                  Update: {
                    "clock_offset_sec"?: number | null,"clock_offset_source"?: string | null,"created_asset"?: boolean,"created_at"?: string,"expected_channels"?: number,"http_port"?: number,"id"?: string,"location_id"?: string,"migrated_from_location_id"?: string | null,"monitoring_disabled_at"?: string | null,"monitoring_disabled_by"?: string | null,"monitoring_disabled_reason"?: string | null,"monitoring_enabled"?: boolean,"org_id"?: string,"rtsp_port"?: number,"secret_id"?: string | null,"updated_at"?: string,"username"?: string | null,"vendor_capabilities"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "recorders_asset_fk"
      columns: ["id","org_id"]
isOneToOne: true
      referencedRelation: "assets"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "recorders_asset_location_fk"
      columns: ["id","location_id"]
isOneToOne: false
      referencedRelation: "assets"
      referencedColumns: ["id","location_id"]
    },{
      foreignKeyName: "recorders_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_hierarchy"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "recorders_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_status"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "recorders_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"regions": {
                  Row: {
                    "archived_at": string | null,"code": string,"created_at": string,"id": string,"name": string,"org_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"code": string,"created_at"?: string,"id"?: string,"name": string,"org_id": string,"updated_at"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"code"?: string,"created_at"?: string,"id"?: string,"name"?: string,"org_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "regions_org_id_fkey"
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
      referencedRelation: "location_hierarchy"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "user_store_access_store_id_org_id_fkey"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "location_status"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "user_store_access_store_id_org_id_fkey"
      columns: ["store_id","org_id"]
isOneToOne: false
      referencedRelation: "locations"
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
                    "camera_id": string | null,"camera_ip": string | null,"location_id": string | null,"org_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                           "camera_id"?: string | null,"camera_ip"?: string | null,"location_id"?: string | null,"org_id"?: string | null
                         }
                        Update: {
                           "camera_id"?: string | null,"camera_ip"?: string | null,"location_id"?: string | null,"org_id"?: string | null
                         }
                        Relationships: [
                    {
      foreignKeyName: "cameras_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_hierarchy"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "cameras_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_status"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "cameras_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "cameras_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"location_hierarchy": {
                  Row: {
                    "cluster_code": string | null,"cluster_id": string | null,"cluster_name": string | null,"code": string | null,"kind": string | null,"location_id": string | null,"name": string | null,"org_id": string | null,"region_code": string | null,"region_id": string | null,"region_name": string | null,"unassigned": boolean | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "locations_cluster_fk"
      columns: ["cluster_id","org_id"]
isOneToOne: false
      referencedRelation: "clusters"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "locations_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"location_status": {
                  Row: {
                    "cameras_down": number | null,"cameras_live": number | null,"cameras_monitoring_off": number | null,"cameras_stale": number | null,"cameras_total": number | null,"cameras_unknown": number | null,"location_id": string | null,"nvr_checked_at": string | null,"nvr_down_since": string | null,"nvr_stale": boolean | null,"nvr_status": string | null,"org_id": string | null,"recorders_down": number | null,"recorders_monitoring_off": number | null,"recorders_total": number | null,"recorders_unknown": number | null,"recorders_up": number | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "locations_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"recorder_endpoints": {
                  Row: {
                    "host": string | null,"http_port": number | null,"location_id": string | null,"monitoring_enabled": boolean | null,"org_id": string | null,"recorder_id": string | null,"rtsp_port": number | null,"username": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "recorders_asset_fk"
      columns: ["recorder_id","org_id"]
isOneToOne: true
      referencedRelation: "assets"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "recorders_asset_location_fk"
      columns: ["recorder_id","location_id"]
isOneToOne: false
      referencedRelation: "assets"
      referencedColumns: ["id","location_id"]
    },{
      foreignKeyName: "recorders_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_hierarchy"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "recorders_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_status"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "recorders_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id","org_id"]
    }
                  ]
                },"recorder_status": {
                  Row: {
                    "checked_at": string | null,"down_since": string | null,"location_id": string | null,"monitoring_enabled": boolean | null,"name": string | null,"org_id": string | null,"recorder_id": string | null,"stale": boolean | null,"status": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "recorders_asset_fk"
      columns: ["recorder_id","org_id"]
isOneToOne: true
      referencedRelation: "assets"
      referencedColumns: ["id","org_id"]
    },{
      foreignKeyName: "recorders_asset_location_fk"
      columns: ["recorder_id","location_id"]
isOneToOne: false
      referencedRelation: "assets"
      referencedColumns: ["id","location_id"]
    },{
      foreignKeyName: "recorders_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_hierarchy"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "recorders_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "location_status"
      referencedColumns: ["location_id","org_id"]
    },{
      foreignKeyName: "recorders_location_fk"
      columns: ["location_id","org_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id","org_id"]
    }
                  ]
                }
          }
          Functions: {
            "access_aal2_of":
{ Args: { "p_claims": Json }; Returns: boolean
                           },
"access_ancestry":
{ Args: { "p_id": string,"p_kind": string,"p_org": string }; Returns: {
              "asset_id": string,"camera_id": string,"cluster_id": string,"location_id": string,"recorder_id": string,"region_id": string
            }[]
                           },
"access_asset_set":
{ Args: { "p_assets": (string)[],"p_clusters": (string)[],"p_locations": (string)[],"p_org": string,"p_org_wide": boolean,"p_recorders": (string)[],"p_regions": (string)[] }; Returns: string[]
                           },
"access_assets_for":
{ Args: { "p_aal2": boolean,"p_at": string,"p_caps": (string)[],"p_ignore_status": boolean,"p_user": string }; Returns: string[]
                           },
"access_bump_version":
{ Args: { "p_user": string }; Returns: number
                           },
"access_bump_versions":
{ Args: { "p_people": (string)[] }; Returns: number
                           },
"access_caller_aal2":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"access_camera_set":
{ Args: { "p_cameras": (string)[],"p_clusters": (string)[],"p_locations": (string)[],"p_org": string,"p_org_wide": boolean,"p_recorders": (string)[],"p_regions": (string)[] }; Returns: string[]
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
"access_check_people_admin":
{ Args: { "p_actor": string,"p_new_role": Database["public"]['Enums']["user_role"],"p_org": string,"p_user": string }; Returns: undefined
                           },
"access_check_spec":
{ Args: { "p_org": string,"p_spec": Json }; Returns: undefined
                           },
"access_expiring":
{ Args: { "p_org": string,"p_within": string }; Returns: {
              "capability": string,"grant_id": string,"org_id": string,"scope_id": string,"scope_kind": string,"user_id": string,"valid_until": string
            }[]
                           },
"access_grant_summary":
{ Args: { "p_org": string }; Returns: {
              "assets": number,"cameras": number,"capability": string,"clusters": number,"locations": number,"next_expiry": string,"organization_wide": boolean,"recorders": number,"regions": number,"user_id": string
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
"access_location_expand":
{ Args: { "p_clusters": (string)[],"p_locations": (string)[],"p_org": string,"p_regions": (string)[] }; Returns: string[]
                           },
"access_location_set":
{ Args: { "p_clusters": (string)[],"p_locations": (string)[],"p_org": string,"p_org_wide": boolean,"p_regions": (string)[] }; Returns: string[]
                           },
"access_locations_for":
{ Args: { "p_aal2": boolean,"p_at": string,"p_caps": (string)[],"p_ignore_status": boolean,"p_user": string }; Returns: string[]
                           },
"access_lock_person":
{ Args: { "p_expected": number,"p_org": string,"p_user": string }; Returns: number
                           },
"access_merge_plan":
{ Args: { "p_from": string,"p_now": string,"p_rows": Json,"p_until": string }; Returns: Record<string, unknown>
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
"access_owner_only":
{ Args: Record<PropertyKey, never>; Returns: (string)[]
                           },
"access_put_grant":
{ Args: { "p_actor": string,"p_needs_review": boolean,"p_org": string,"p_reason": string,"p_source": string,"p_spec": Json,"p_user": string }; Returns: Record<string, unknown>
                           },
"access_review_keep":
{ Args: { "p_actor": string,"p_grant_ids": (string)[],"p_note"?: string,"p_org": string }; Returns: number
                           },
"access_review_self_confirm":
{ Args: { "p_actor": string,"p_grant_ids": (string)[],"p_org": string,"p_reason": string }; Returns: number
                           },
"access_scope_covers":
{ Args: { "p_held_id": string,"p_held_kind": string,"p_id": string,"p_kind": string,"p_org": string }; Returns: boolean
                           },
"access_session_capabilities":
{ Args: { "p_claims": Json,"p_mfa_enforced": boolean,"p_user": string }; Returns: string[]
                           },
"access_target_ancestry":
{ Args: { "p_org": string,"p_targets": Json }; Returns: {
              "cluster_id": string,"id": string,"kind": string,"location_id": string,"recorder_id": string,"region_id": string
            }[]
                           },
"access_teardown_test_org_people":
{ Args: { "p_org": string }; Returns: number
                           },
"access_twin_violations":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"address_space_global":
{ Args: { "p_org": string }; Returns: string
                           },
"any_cctv_camera_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"any_grant_cluster_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"any_grant_location_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"any_grant_region_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"apply_access_change":
{ Args: { "p_actor": string,"p_changes": Json,"p_expected_version"?: number,"p_org": string,"p_user": string }; Returns: Json
                           },
"asset_sync_endpoints":
{ Args: { "p_asset": string }; Returns: undefined
                           },
"camera_group_rule_members":
{ Args: { "p_groups"?: (string)[],"p_org": string }; Returns: {
              "camera_id": string,"group_id": string
            }[]
                           },
"camera_merge":
{ Args: { "p_actor"?: string,"p_duplicate": string,"p_keep": string,"p_org": string }; Returns: Json
                           },
"camera_remap":
{ Args: { "p_actor"?: string,"p_at"?: string,"p_camera": string,"p_channel": number,"p_org": string,"p_recorder": string }; Returns: string
                           },
"cameras_monitoring_off":
{ Args: { "p_ids": (string)[] }; Returns: string[]
                           },
"cameras_with_capability":
{ Args: { "p_cap": string,"p_ids": (string)[] }; Returns: string[]
                           },
"capability_asset_ids":
{ Args: { "p_cap": string }; Returns: string[]
                           },
"capability_camera_ids":
{ Args: { "p_cap": string }; Returns: string[]
                           },
"capability_location_ids":
{ Args: { "p_cap": string }; Returns: string[]
                           },
"cctv_visible_group_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"change_person_role":
{ Args: { "p_actor": string,"p_expected_version"?: number,"p_org": string,"p_role": Database["public"]['Enums']["user_role"],"p_user": string }; Returns: Json
                           },
"current_org_id":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"current_user_role":
{ Args: Record<PropertyKey, never>; Returns: Database["public"]['Enums']["user_role"]
                           },
"discovery_apply":
{ Args: { "p_actor"?: string,"p_findings"?: Json,"p_ops": Json,"p_org": string,"p_recorder": string,"p_to_reconcile"?: number }; Returns: Json
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
{ Args: { "p_actor"?: string,"p_org": string,"p_user": string }; Returns: number
                           },
"group_member_counts":
{ Args: { "p_cap"?: string }; Returns: {
              "cameras": number,"group_id": string
            }[]
                           },
"group_rule_members":
{ Args: { "p_group"?: string }; Returns: {
              "camera_id": string,"group_id": string
            }[]
                           },
"has_capability":
{ Args: { "p_cap": string }; Returns: boolean
                           },
"has_capability_for":
{ Args: { "p_cap": string,"p_id": string,"p_kind": string }; Returns: boolean
                           },
"has_capability_for_user":
{ Args: { "p_aal2"?: boolean,"p_cap": string,"p_id": string,"p_kind": string,"p_user": string }; Returns: boolean
                           },
"inventory_affected_people":
{ Args: { "p_id": string,"p_kind": string,"p_org": string }; Returns: (string)[]
                           },
"inventory_apply_proposals":
{ Args: { "p_actor"?: string,"p_items": Json,"p_org": string }; Returns: Json
                           },
"inventory_archive":
{ Args: { "p_actor"?: string,"p_id": string,"p_kind": string,"p_org": string }; Returns: Json
                           },
"inventory_effective_snapshot":
{ Args: { "p_at"?: string,"p_org": string }; Returns: {
              "assets": (string)[],"cameras": (string)[],"capability": string,"locations": (string)[],"user_id": string
            }[]
                           },
"inventory_ensure_placeholders":
{ Args: { "p_count": number,"p_location": string,"p_org": string,"p_recorder": string }; Returns: Json
                           },
"inventory_import_apply":
{ Args: { "p_actor": string,"p_org": string,"p_plan": Json }; Returns: Json
                           },
"inventory_move_cluster":
{ Args: { "p_actor"?: string,"p_cluster": string,"p_org": string,"p_region": string }; Returns: Json
                           },
"inventory_move_location":
{ Args: { "p_actor"?: string,"p_cluster": string,"p_location": string,"p_org": string }; Returns: Json
                           },
"inventory_propose_hierarchy":
{ Args: { "p_org": string }; Returns: {
              "code": string,"existing_cluster_id": string,"existing_region_id": string,"location_id": string,"proposed_cluster_code": string,"proposed_region_code": string,"state": string,"zone": string
            }[]
                           },
"inventory_purge_test_org":
{ Args: { "p_org": string }; Returns: Json
                           },
"inventory_refresh_statistics":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"inventory_remap_effects":
{ Args: { "p_camera": string,"p_from": string,"p_org": string,"p_to": string }; Returns: undefined
                           },
"inventory_require_test_org":
{ Args: { "p_org": string }; Returns: undefined
                           },
"inventory_restore":
{ Args: { "p_actor"?: string,"p_id": string,"p_kind": string,"p_org": string }; Returns: Json
                           },
"inventory_stale_name_scan":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"it_view_asset_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"it_view_endpoint_asset_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"it_view_location_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"it_view_recorder_ids":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"media_session_close":
{ Args: { "p_sid": string }; Returns: boolean
                           },
"media_session_create":
{ Args: { "p_aal2"?: boolean,"p_cameras": (string)[],"p_connect_sec"?: number,"p_kind": string,"p_max_sec"?: number,"p_org": string,"p_streams"?: (string)[],"p_user": string }; Returns: {
              "camera_id": string,"sid": string
            }[]
                           },
"media_session_open":
{ Args: { "p_camera": string,"p_kind": string,"p_sid": string,"p_stream": string,"p_user": string }; Returns: {
              "expires_at": string,"kind": string,"ok": boolean,"reason": string,"stream": string
            }[]
                           },
"media_session_problem":
{ Args: { "m": Omit<Database["public"]['Tables']["media_sessions"]['Row'], Database["public"]['Tables']["media_sessions"]['ComputedFields']> }; Returns: string
                           },
"media_session_target_problem":
{ Args: { "p_aal2": boolean,"p_asset": string,"p_camera": string,"p_kind": string,"p_org": string,"p_user": string }; Returns: string
                           },
"media_sessions_age_test":
{ Args: { "p_seconds": number,"p_sid": string }; Returns: undefined
                           },
"media_sessions_prune":
{ Args: { "p_keep"?: string,"p_org"?: string,"p_unopened_keep"?: string }; Returns: number
                           },
"media_sessions_recheck_budget":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"media_sessions_revalidate":
{ Args: { "p_org": string,"p_users": (string)[] }; Returns: number
                           },
"media_sessions_revoke_user":
{ Args: { "p_org": string,"p_reason": string,"p_user": string }; Returns: number
                           },
"media_sessions_still_valid":
{ Args: { "p_sids": (string)[] }; Returns: {
              "reason": string,"sid": string
            }[]
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
              "asset_ids": (string)[],"camera_ids": (string)[],"capability": string,"cluster_ids": (string)[],"covered_location_ids": (string)[],"location_ids": (string)[],"organization_wide": boolean,"recorder_camera_ids": (string)[],"recorder_ids": (string)[],"region_ids": (string)[]
            }[]
                           },
"network_address_conflicts":
{ Args: { "p_org": string }; Returns: {
              "asset_id": string,"host": string,"location_id": string,"other_location_id": string,"status": string
            }[]
                           },
"network_validate_address":
{ Args: { "p_asset": string,"p_host": string,"p_org": string }; Returns: string
                           },
"preview_access_change":
{ Args: { "p_at"?: string,"p_changes": Json,"p_org": string,"p_sample"?: number,"p_user": string }; Returns: Json
                           },
"preview_hierarchy_change":
{ Args: { "p_id": string,"p_kind": string,"p_new_parent": string,"p_org": string }; Returns: Json
                           },
"preview_hierarchy_proposals":
{ Args: { "p_items": Json,"p_org": string }; Returns: Json
                           },
"privilege_violations":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"recorder_credential_status":
{ Args: { "p_org": string,"p_recorder": string }; Returns: Json
                           },
"recorder_delete_credential":
{ Args: { "p_recorder": string }; Returns: undefined
                           },
"recorder_primary_of":
{ Args: { "p_location": string }; Returns: string
                           },
"recorder_read_credential":
{ Args: { "p_recorder": string }; Returns: string
                           },
"recorder_save":
{ Args: { "p_actor"?: string,"p_expected_channels"?: number,"p_host": string,"p_http_port": number,"p_location": string,"p_name"?: string,"p_org": string,"p_recorder": string,"p_rtsp_port": number,"p_username": string }; Returns: string
                           },
"recorder_set_monitoring":
{ Args: { "p_actor"?: string,"p_enabled": boolean,"p_org": string,"p_reason": string,"p_recorder": string }; Returns: Json
                           },
"recorder_store_credential":
{ Args: { "p_recorder": string,"p_secret": string }; Returns: string
                           },
"replace_user_grants":
{ Args: { "p_actor"?: string,"p_capabilities": (string)[],"p_expected_version"?: number,"p_grants": Json,"p_org": string,"p_reason"?: string,"p_scope_kinds": (string)[],"p_user": string }; Returns: Json
                           },
"report_effective_asset_ids":
{ Args: { "p_at"?: string,"p_cap": string,"p_ignore_status"?: boolean,"p_user": string }; Returns: string[]
                           },
"report_effective_camera_ids":
{ Args: { "p_at"?: string,"p_cap": string,"p_ignore_status"?: boolean,"p_user": string }; Returns: string[]
                           },
"revoke_grant":
{ Args: { "p_actor"?: string,"p_expected_version"?: number,"p_grant_ids": (string)[],"p_org": string,"p_reason"?: string,"p_user": string }; Returns: Json
                           },
"revoke_user_sessions":
{ Args: { "p_user": string }; Returns: undefined
                           },
"set_person_active":
{ Args: { "p_active": boolean,"p_actor": string,"p_org": string,"p_user": string }; Returns: boolean
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
                           },
"wifi_inventory":
{ Args: Record<PropertyKey, never>; Returns: {
              "asset_id": string,"asset_type": string,"assigned_profile_id": string,"capability_discovered_at": string,"down_since": string,"enabled": boolean,"firmware": string,"last_checked_at": string,"last_inventory_at": string,"lifecycle_state": string,"location_code": string,"location_id": string,"location_name": string,"mac": string,"management_ip": string,"management_mode": string,"model": string,"name": string,"role": string,"serial": string,"status": string,"vendor": string
            }[]
                           }
          }
          Enums: {
            "device_type": "nvr"|"server"|"attendance"|"footfall"|"other"|"sdwan_edge"|"switch"|"access_point"|"router"|"ups"|"printer"|"desktop"|"laptop","user_role": "user"|"operator"|"manager"|"admin"|"platform_owner"
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
            "device_type": ["nvr", "server", "attendance", "footfall", "other", "sdwan_edge", "switch", "access_point", "router", "ups", "printer", "desktop", "laptop"],"user_role": ["user", "operator", "manager", "admin", "platform_owner"]
          }
        }
} as const
